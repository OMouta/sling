/**
 * Adding and changing installations, for the routes and for the assistant's
 * setup tools alike: the same checks, connection test, audit, and live
 * update either way.
 */
import type { AnyConnector, TestResult } from "@sling/connector-sdk";
import { type InstallationView, newId } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { audit } from "../../audit.ts";
import type { AppContext } from "../../context.ts";
import { withSignIn } from "../../oauth/credentials.ts";
import { type InstallationRow, toInstallationView } from "../views.ts";
import { readCredentials, writeCredentials } from "./installations.ts";

const TEST_TIMEOUT_MS = 30_000;

interface Owner {
  workspaceId: string;
  userId: string;
}

/** An installation the request can't create or change, with the status to answer. */
export class InstallationError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  /** Set when the connection test failed, so the form can offer to add it anyway. */
  readonly check: "failed" | undefined;
  constructor(message: string, status: 400 | 404 | 409 | 422 = 400, check?: "failed") {
    super(message);
    this.status = status;
    this.check = check;
  }
}

export function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

export async function ownedInstallation(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
  id: string,
): Promise<InstallationRow | null> {
  const [row] = await ctx.db
    .select()
    .from(schema.connectorInstallations)
    .where(
      and(
        eq(schema.connectorInstallations.id, id),
        eq(schema.connectorInstallations.workspaceId, workspaceId),
      ),
    );
  return row ?? null;
}

export function connectorLog(ctx: AppContext, connectorId: string, installationId?: string) {
  const log = ctx.log.child({
    connector: connectorId,
    ...(installationId ? { installationId } : {}),
  });
  return {
    info: (m: string, d?: Record<string, unknown>) => log.info(d ?? {}, m),
    warn: (m: string, d?: Record<string, unknown>) => log.warn(d ?? {}, m),
    error: (m: string, d?: Record<string, unknown>) => log.error(d ?? {}, m),
  };
}

/** Runs the connector's connection test. Never throws. */
export async function testConnection(
  ctx: AppContext,
  connector: AnyConnector,
  credentials: unknown,
  config: unknown,
  where: { workspaceId: string; installationId?: string },
): Promise<TestResult> {
  try {
    const test = {
      credentials,
      config,
      log: connectorLog(ctx, connector.id, where.installationId),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      workspaceId: where.workspaceId,
    };
    return await connector.test(test);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The connector's name, or "Name 2" and so on when the workspace already has one by that name. */
export async function freeInstallationName(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
  base: string,
): Promise<string> {
  const rows = await ctx.db
    .select({ name: schema.connectorInstallations.name })
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId));
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function publish(ctx: AppContext, row: InstallationRow): InstallationView {
  const view = toInstallationView(row);
  ctx.hub.publish(row.workspaceId, { type: "installation.updated", installation: view });
  return view;
}

export interface CreateInstallation {
  connectorId: string;
  /** Defaults to the connector's name, numbered when it's taken. */
  name?: string | undefined;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
  enabled: boolean;
  /** Runs the connection test first, and saves nothing if it fails. */
  check: boolean;
}

export async function createInstallation(
  ctx: AppContext,
  actor: Owner,
  body: CreateInstallation,
): Promise<InstallationView> {
  const connector = ctx.registry.connector(body.connectorId);
  if (!connector) throw new InstallationError(`Unknown connector ${body.connectorId}`);
  const creds = connector.credentialsSchema.safeParse(body.credentials);
  if (!creds.success) throw new InstallationError(`Credentials: ${issuesOf(creds.error)}`);
  const config = connector.configSchema.safeParse(body.config);
  if (!config.success) throw new InstallationError(`Config: ${issuesOf(config.error)}`);
  if (body.check) {
    const result = await testConnection(
      ctx,
      connector,
      await withSignIn(
        ctx,
        { workspaceId: actor.workspaceId, connectorId: connector.id, config: config.data },
        creds.data as Record<string, unknown>,
      ),
      config.data,
      { workspaceId: actor.workspaceId },
    );
    if (!result.ok) throw new InstallationError(result.error, 422, "failed");
  }
  const name = body.name ?? (await freeInstallationName(ctx, actor.workspaceId, connector.name));
  const id = newId("ins");
  const row = await ctx.db.transaction(async (tx) => {
    const credentialId = await writeCredentials(
      ctx,
      tx,
      { workspaceId: actor.workspaceId, ownerId: actor.userId },
      null,
      creds.data as Record<string, unknown>,
    );
    const [created] = await tx
      .insert(schema.connectorInstallations)
      .values({
        id,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        connectorId: connector.id,
        name,
        credentialId,
        config: config.data as Record<string, unknown>,
        enabled: body.enabled,
        status: body.enabled ? "idle" : "disabled",
      })
      .returning();
    return created;
  });
  if (!row) throw new Error("insert failed");
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "installation.created",
    subjectType: "installation",
    subjectId: id,
    details: { connectorId: connector.id, name },
  });
  // Before the source starts, so it may already reach the host in its config.
  await ctx.extensions.installationsChanged(connector.id);
  await ctx.connectors.reconcile(actor.workspaceId);
  const fresh = (await ownedInstallation(ctx, actor.workspaceId, id)) ?? row;
  return publish(ctx, fresh);
}

export interface UpdateInstallation {
  name?: string | undefined;
  /** Merged over the stored credentials. Never returned. */
  credentials?: Record<string, unknown> | undefined;
  config?: Record<string, unknown> | undefined;
  enabled?: boolean | undefined;
  /** Runs the connection test on the new credentials or config, and saves nothing if it fails. */
  check: boolean;
}

export async function updateInstallation(
  ctx: AppContext,
  actor: Owner,
  row: InstallationRow,
  body: UpdateInstallation,
): Promise<InstallationView> {
  const connector = ctx.registry.connector(row.connectorId);
  if (!connector) throw new InstallationError(`Connector ${row.connectorId} isn't available`, 409);
  let creds: Record<string, unknown> | null = null;
  if (body.credentials) {
    const merged = { ...(await readCredentials(ctx, row)), ...body.credentials };
    const parsed = connector.credentialsSchema.safeParse(merged);
    if (!parsed.success) throw new InstallationError(`Credentials: ${issuesOf(parsed.error)}`);
    creds = parsed.data as Record<string, unknown>;
  }
  let config: Record<string, unknown> | null = null;
  if (body.config) {
    const parsed = connector.configSchema.safeParse(body.config);
    if (!parsed.success) throw new InstallationError(`Config: ${issuesOf(parsed.error)}`);
    config = parsed.data as Record<string, unknown>;
  }
  if (body.check && (creds || config)) {
    const tested = config ?? connector.configSchema.parse(row.config);
    const result = await testConnection(
      ctx,
      connector,
      await withSignIn(
        ctx,
        { ...row, config: tested },
        creds ?? connector.credentialsSchema.parse(await readCredentials(ctx, row)),
      ),
      tested,
      { workspaceId: row.workspaceId, installationId: row.id },
    );
    if (!result.ok) throw new InstallationError(result.error, 422, "failed");
  }
  await ctx.db.transaction(async (tx) => {
    const credentialId = creds
      ? await writeCredentials(
          ctx,
          tx,
          { workspaceId: row.workspaceId, ownerId: row.ownerId },
          row.credentialId,
          creds,
        )
      : row.credentialId;
    await tx
      .update(schema.connectorInstallations)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(config ? { config } : {}),
        ...(body.enabled !== undefined
          ? { enabled: body.enabled, status: body.enabled ? "idle" : "disabled" }
          : {}),
        credentialId,
      })
      .where(eq(schema.connectorInstallations.id, row.id));
  });
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "installation.updated",
    subjectType: "installation",
    subjectId: row.id,
    details: {
      fields: Object.keys(body).filter(
        (k) => k !== "credentials" && body[k as keyof UpdateInstallation] !== undefined,
      ),
      credentialsChanged: Boolean(creds),
    },
  });
  if (config) await ctx.extensions.installationsChanged(row.connectorId);
  // New credentials or config only take effect in a fresh source.
  if (creds || config || body.enabled !== undefined) await ctx.connectors.restart(row.id);
  const fresh = await ownedInstallation(ctx, actor.workspaceId, row.id);
  if (!fresh) throw new InstallationError("not found", 404);
  return publish(ctx, fresh);
}
