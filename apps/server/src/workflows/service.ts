import { newId } from "@sling/core";
import { schema } from "@sling/db";
import {
  emptyDefinition,
  type PublishResult,
  SLING_EVENTS,
  type TemplateView,
  type ValidationIssue,
  validate,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowDetailView,
  type WorkflowVersionView,
} from "@sling/workflow";
import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { workspaceOwner } from "./connectors/installations.ts";
import { passedSchedules } from "./one-time.ts";
import {
  applyBindings,
  loadTemplates,
  missingNodeTypes,
  TEMPLATES_DIR,
  type Template,
} from "./templates.ts";
import { syncTriggers, webhookUrl } from "./triggers.ts";
import { type WorkflowRow, workflowSummary } from "./views.ts";

/** The template every workspace gets: web chat runs through it. */
export const ASSISTANT_TEMPLATE = "sling-assistant";

export class WorkflowInputError extends Error {
  readonly status: number;
  readonly issues: ValidationIssue[];
  constructor(message: string, status = 400, issues: ValidationIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

interface Actor {
  userId: string;
  workspaceId: string;
}

/** JSON with sorted keys, so two definitions compare equal regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class WorkflowService {
  readonly #ctx: AppContext;
  readonly #dir: string;
  #templates: Template[] | null = null;

  constructor(ctx: AppContext, templatesDir: string = TEMPLATES_DIR) {
    this.#ctx = ctx;
    this.#dir = templatesDir;
  }

  // ------------------------------------------------------------- templates

  /** Bundled templates, then those of enabled extensions (keyed `<extension>/<key>`). */
  templates(): Template[] {
    const bundled = this.#bundled();
    const fromExtensions = this.#ctx.extensions?.templates() ?? [];
    return fromExtensions.length > 0 ? [...bundled, ...fromExtensions] : bundled;
  }

  #bundled(): Template[] {
    if (!this.#templates) {
      this.#templates = loadTemplates(this.#dir, (key, err) =>
        this.#ctx.log.error({ err, key }, "skipping a broken workflow template"),
      );
      for (const t of this.#templates) {
        const missing = missingNodeTypes(this.#ctx.registry, t.definition);
        if (missing.length > 0) {
          this.#ctx.log.info(
            { key: t.view.key, missing },
            "template not offered: missing node types",
          );
        }
      }
    }
    return this.#templates;
  }

  /** Templates whose node types are all available. The rest are left out, with the reason logged. */
  availableTemplates(): TemplateView[] {
    const out: TemplateView[] = [];
    for (const t of this.templates()) {
      if (missingNodeTypes(this.#ctx.registry, t.definition).length > 0) continue;
      out.push(t.view);
    }
    return out;
  }

  /** Why a template can't be installed, or null if it can. */
  unavailableReason(key: string): string | null {
    const t = this.templates().find((x) => x.view.key === key);
    if (!t) return `No template ${key}`;
    const missing = missingNodeTypes(this.#ctx.registry, t.definition);
    return missing.length > 0
      ? `This template needs nodes that aren't installed: ${missing.join(", ")}`
      : null;
  }

  // ------------------------------------------------------------- reads

  async get(workspaceId: string, id: string): Promise<WorkflowRow | null> {
    const [row] = await this.#ctx.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)));
    return row ?? null;
  }

  async list(workspaceId: string) {
    const rows = await this.#ctx.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, workspaceId))
      .orderBy(desc(schema.workflows.updatedAt));
    return Promise.all(rows.map((w) => workflowSummary(this.#ctx, w)));
  }

  async detail(wf: WorkflowRow): Promise<WorkflowDetailView> {
    const active = wf.activeVersionId ? await this.#ctx.engine.version(wf.activeVersionId) : null;
    const webhooks = (active?.definition.nodes ?? [])
      .filter((n) => n.type === "core.webhook")
      .map((n) => ({ nodeId: n.id, url: webhookUrl(this.#ctx, wf.id, n.id) }));
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      templateKey: wf.templateKey,
      activeVersion: active?.number ?? null,
      hasUnpublishedChanges: wf.draftDirty,
      draft: WorkflowDefinitionSchema.parse(wf.draft),
      active: active?.definition ?? null,
      webhooks,
      createdAt: wf.createdAt.toISOString(),
      updatedAt: wf.updatedAt.toISOString(),
    };
  }

  async versions(wf: WorkflowRow): Promise<WorkflowVersionView[]> {
    const rows = await this.#ctx.db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, wf.id))
      .orderBy(desc(schema.workflowVersions.number));
    return rows.map((v) => ({
      number: v.number,
      note: v.note,
      createdAt: v.createdAt.toISOString(),
      definition: WorkflowDefinitionSchema.parse(v.definition),
    }));
  }

  async version(wf: WorkflowRow, n: number): Promise<WorkflowVersionView | null> {
    const [v] = await this.#ctx.db
      .select()
      .from(schema.workflowVersions)
      .where(
        and(eq(schema.workflowVersions.workflowId, wf.id), eq(schema.workflowVersions.number, n)),
      );
    if (!v) return null;
    return {
      number: v.number,
      note: v.note,
      createdAt: v.createdAt.toISOString(),
      definition: WorkflowDefinitionSchema.parse(v.definition),
    };
  }

  /** The workspace's Sling Assistant workflow, which owns conversations from before workflows. */
  async assistantId(workspaceId: string): Promise<string | null> {
    const [row] = await this.#ctx.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.workspaceId, workspaceId),
          eq(schema.workflows.templateKey, ASSISTANT_TEMPLATE),
        ),
      )
      .orderBy(asc(schema.workflows.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  // ------------------------------------------------------------- writes

  async create(
    actor: Actor,
    input: {
      definition?: WorkflowDefinition;
      name?: string;
      description?: string;
      templateKey?: string | null;
    },
  ): Promise<WorkflowRow> {
    const def = input.definition ?? emptyDefinition(input.name?.trim() || "Untitled workflow");
    const draft: WorkflowDefinition = {
      ...def,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    const [row] = await this.#ctx.db
      .insert(schema.workflows)
      .values({
        id: newId("wfl"),
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        name: draft.name,
        description: draft.description,
        draft: draft as unknown as Record<string, unknown>,
        draftDirty: true,
        templateKey: input.templateKey ?? null,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "workflow.created",
      subjectType: "workflow",
      subjectId: row.id,
      details: { templateKey: row.templateKey },
    });
    await this.#published(row);
    return row;
  }

  /**
   * Installs a template: placeholders are bound to installations, version 1
   * is published, and built-in templates are enabled. A name replaces the
   * template's own.
   */
  async install(
    actor: Actor,
    key: string,
    bindings: Record<string, string>,
    opts: { name?: string } = {},
  ): Promise<WorkflowRow> {
    const t = this.templates().find((x) => x.view.key === key);
    if (!t) throw new WorkflowInputError(`No template ${key}`, 404);
    const reason = this.unavailableReason(key);
    if (reason) throw new WorkflowInputError(reason);
    const map: Record<string, string> = {};
    for (const b of t.view.bindings) {
      const id = bindings[b.placeholder];
      if (!id)
        throw new WorkflowInputError(`Pick an installation for ${b.label} (${b.placeholder})`);
      const [inst] = await this.#ctx.db
        .select({ connectorId: schema.connectorInstallations.connectorId })
        .from(schema.connectorInstallations)
        .where(
          and(
            eq(schema.connectorInstallations.id, id),
            eq(schema.connectorInstallations.workspaceId, actor.workspaceId),
          ),
        );
      if (!inst) throw new WorkflowInputError(`No installation ${id}`);
      if (inst.connectorId !== b.connectorId) {
        throw new WorkflowInputError(
          `${b.placeholder} needs a ${b.connectorId} installation, not ${inst.connectorId}`,
        );
      }
      map[b.placeholder] = id;
    }
    const definition = applyBindings(t.definition, map);
    const created = await this.create(actor, {
      definition,
      templateKey: key,
      ...(opts.name ? { name: opts.name } : {}),
    });
    const result = await this.publish(actor, created, "Installed from template");
    const row = (await this.get(actor.workspaceId, created.id)) ?? created;
    if (result.ok && t.view.builtIn) return (await this.setEnabled(actor, row, true)) ?? row;
    return row;
  }

  async saveDraft(wf: WorkflowRow, definition: WorkflowDefinition): Promise<WorkflowRow> {
    const active = wf.activeVersionId ? await this.#ctx.engine.version(wf.activeVersionId) : null;
    const dirty = !active || canonical(active.definition) !== canonical(definition);
    const [row] = await this.#ctx.db
      .update(schema.workflows)
      .set({
        draft: definition as unknown as Record<string, unknown>,
        draftDirty: dirty,
        name: definition.name,
        description: definition.description,
      })
      .where(eq(schema.workflows.id, wf.id))
      .returning();
    if (!row) throw new WorkflowInputError("not found", 404);
    await this.#published(row);
    return row;
  }

  async validateDraft(wf: WorkflowRow): Promise<ValidationIssue[]> {
    const parsed = WorkflowDefinitionSchema.safeParse(wf.draft);
    if (!parsed.success) {
      return parsed.error.issues.map((i) => ({
        code: "invalid_shape",
        message: `${i.path.join(".") || "definition"}: ${i.message}`,
      }));
    }
    return this.issues(wf.workspaceId, parsed.data);
  }

  /** What stops a definition from publishing: the validator's issues, and one-time schedules already past. */
  async issues(workspaceId: string, definition: WorkflowDefinition): Promise<ValidationIssue[]> {
    const issues = validate(definition, this.#ctx.registry);
    if (!definition.nodes.some((n) => n.type === "core.schedule")) return issues;
    const passed = passedSchedules(definition, await workspaceTimeZone(this.#ctx, workspaceId));
    return [...issues, ...passed.map(({ when: _when, ...issue }) => issue)];
  }

  /** Validates the draft and, if it passes, makes it the next version and re-subscribes triggers. */
  async publish(actor: Actor, wf: WorkflowRow, note: string): Promise<PublishResult> {
    const issues = await this.validateDraft(wf);
    if (issues.length > 0) return { ok: false, version: null, issues };
    const definition = WorkflowDefinitionSchema.parse(wf.draft);
    const number = await this.#ctx.db.transaction(async (tx) => {
      // Lock the workflow so two publishes can't take the same number.
      await tx
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, wf.id))
        .for("update");
      const [m] = await tx
        .select({ n: max(schema.workflowVersions.number) })
        .from(schema.workflowVersions)
        .where(eq(schema.workflowVersions.workflowId, wf.id));
      const n = (m?.n ?? 0) + 1;
      const versionId = newId("wfv");
      await tx.insert(schema.workflowVersions).values({
        id: versionId,
        workspaceId: wf.workspaceId,
        ownerId: actor.userId,
        workflowId: wf.id,
        number: n,
        definition: definition as unknown as Record<string, unknown>,
        note: note.slice(0, 500),
      });
      await tx
        .update(schema.workflows)
        .set({
          activeVersionId: versionId,
          draftDirty: false,
          name: definition.name,
          description: definition.description,
        })
        .where(eq(schema.workflows.id, wf.id));
      return n;
    });
    await syncTriggers(this.#ctx, wf.id);
    await audit(this.#ctx, {
      workspaceId: wf.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "workflow.published",
      subjectType: "workflow",
      subjectId: wf.id,
      details: { version: number },
    });
    const fresh = await this.get(wf.workspaceId, wf.id);
    if (fresh) await this.#published(fresh);
    return { ok: true, version: number, issues: [] };
  }

  async setEnabled(actor: Actor, wf: WorkflowRow, enabled: boolean): Promise<WorkflowRow | null> {
    if (enabled && !wf.activeVersionId) {
      throw new WorkflowInputError("Publish a version before enabling the workflow.", 409);
    }
    if (enabled && !wf.enabled && wf.activeVersionId) {
      const active = await this.#ctx.engine.version(wf.activeVersionId);
      const passed = active
        ? passedSchedules(active.definition, await workspaceTimeZone(this.#ctx, wf.workspaceId))
        : [];
      if (passed[0]) {
        throw new WorkflowInputError(
          `It was set to run once, ${passed[0].when}, which has passed. Set a new time first.`,
          409,
          passed.map(({ when: _when, ...issue }) => issue),
        );
      }
    }
    const [row] = await this.#ctx.db
      .update(schema.workflows)
      .set({ enabled })
      .where(eq(schema.workflows.id, wf.id))
      .returning();
    await syncTriggers(this.#ctx, wf.id);
    if (enabled !== wf.enabled) {
      await audit(this.#ctx, {
        workspaceId: wf.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: enabled ? "workflow.enabled" : "workflow.disabled",
        subjectType: "workflow",
        subjectId: wf.id,
      });
    }
    if (row) await this.#published(row);
    return row ?? null;
  }

  /** Turns off a workflow whose one-time schedule has fired. */
  async ranOnce(wf: WorkflowRow): Promise<void> {
    const [row] = await this.#ctx.db
      .update(schema.workflows)
      .set({ enabled: false })
      .where(and(eq(schema.workflows.id, wf.id), eq(schema.workflows.enabled, true)))
      .returning();
    if (!row) return;
    await syncTriggers(this.#ctx, wf.id);
    await audit(this.#ctx, {
      workspaceId: wf.workspaceId,
      actorType: "system",
      verb: "workflow.disabled",
      subjectType: "workflow",
      subjectId: wf.id,
      details: { reason: "ran_once" },
    });
    await this.#published(row);
  }

  async update(
    actor: Actor,
    wf: WorkflowRow,
    patch: { name?: string; description?: string; enabled?: boolean },
  ): Promise<WorkflowRow> {
    let row = wf;
    if (patch.name !== undefined || patch.description !== undefined) {
      const draft = WorkflowDefinitionSchema.parse(wf.draft);
      row = await this.saveDraft(wf, {
        ...draft,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      });
    }
    if (patch.enabled !== undefined)
      row = (await this.setEnabled(actor, row, patch.enabled)) ?? row;
    return row;
  }

  async remove(actor: Actor, wf: WorkflowRow): Promise<void> {
    const builtIn = this.templates().find((t) => t.view.key === wf.templateKey)?.view.builtIn;
    if (builtIn) {
      throw new WorkflowInputError(
        `${wf.name} is built in. Disable it instead; it would be installed again on the next start.`,
        409,
      );
    }
    // Drops triggers and schedules first, so nothing starts a run mid-delete.
    await this.#ctx.db
      .update(schema.workflows)
      .set({ enabled: false })
      .where(eq(schema.workflows.id, wf.id));
    await syncTriggers(this.#ctx, wf.id);
    await this.#ctx.db.delete(schema.workflows).where(eq(schema.workflows.id, wf.id));
    await audit(this.#ctx, {
      workspaceId: wf.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "workflow.deleted",
      subjectType: "workflow",
      subjectId: wf.id,
      details: { name: wf.name },
    });
  }

  /**
   * Installs and enables built-in templates that a workspace doesn't have
   * yet. Conversations from before workflows are given to Sling Assistant.
   */
  async ensureBuiltIns(workspaceId?: string): Promise<void> {
    const workspaces = workspaceId
      ? [{ id: workspaceId }]
      : await this.#ctx.db.select({ id: schema.workspaces.id }).from(schema.workspaces);
    for (const ws of workspaces) {
      const owner = await workspaceOwner(this.#ctx, ws.id);
      if (!owner) continue;
      for (const t of this.templates()) {
        if (!t.view.builtIn) continue;
        const [existing] = await this.#ctx.db
          .select({ id: schema.workflows.id })
          .from(schema.workflows)
          .where(
            and(
              eq(schema.workflows.workspaceId, ws.id),
              eq(schema.workflows.templateKey, t.view.key),
            ),
          )
          .limit(1);
        if (existing) continue;
        const reason = this.unavailableReason(t.view.key);
        if (reason) {
          this.#ctx.log.warn({ key: t.view.key, reason }, "can't install a built-in workflow");
          continue;
        }
        await this.install({ userId: owner, workspaceId: ws.id }, t.view.key, {});
        this.#ctx.log.info({ workspaceId: ws.id, key: t.view.key }, "installed built-in workflow");
      }
      const assistant = await this.assistantId(ws.id);
      if (assistant) {
        await this.#ctx.db
          .update(schema.conversations)
          // Linking an old conversation isn't activity, so it keeps its place in the list.
          .set({ workflowId: assistant, updatedAt: sql`${schema.conversations.updatedAt}` })
          .where(
            and(
              eq(schema.conversations.workspaceId, ws.id),
              isNull(schema.conversations.workflowId),
            ),
          );
      }
    }
  }

  /** Whether any enabled workflow in the workspace listens for web chat messages. */
  async handlesChat(workspaceId: string): Promise<boolean> {
    const [row] = await this.#ctx.db
      .select({ id: schema.workflowTriggers.id })
      .from(schema.workflowTriggers)
      .where(
        and(
          eq(schema.workflowTriggers.workspaceId, workspaceId),
          eq(schema.workflowTriggers.event, SLING_EVENTS.chatMessage),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async #published(row: WorkflowRow) {
    this.#ctx.hub.publish(row.workspaceId, {
      type: "workflow.updated",
      workflow: await workflowSummary(this.#ctx, row),
    });
  }
}
