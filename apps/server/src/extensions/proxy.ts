/**
 * Server-side stand-ins for what an extension adds. They look like ordinary
 * connectors to the registry, the workflow engine, the connector runtime, and
 * the sandbox service, and every function calls into the extension's
 * process. The checks on what the extension may ask for live here, on the
 * server side: the process itself is never trusted.
 */
import type {
  AnyConnector,
  ConnectorDescription,
  ExecutionProvider,
  ExtensionDescription,
  JsonSchemaObject,
  NodeDescription,
  ProviderContext,
  SourceContext,
  TestResult,
} from "@sling/connector-sdk";
import {
  type AnyNodeSpec,
  type NodeContext,
  NodeError,
  type NodeResult,
  type TriggerMatch,
} from "@sling/workflow";
import { z } from "zod";
import { parseSetupResult } from "../workflows/connectors/setup.ts";
import { assistantUse } from "./checks.ts";
import type { CallScope, ExtensionHost, HostVersion, SourceScope } from "./host.ts";

/** A zod schema from a stored JSON Schema. The extension re-checks with its real schema. */
export function schemaFromJson(json: JsonSchemaObject): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.looseObject({});
  }
}

// ------------------------------------------------------------- results

const Outputs = z.record(z.string(), z.unknown());

function nodeResultSchema(extensionId: string) {
  const Wait = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("timer"), until: z.date() }),
    z.object({
      kind: z.literal("event"),
      eventType: z
        .string()
        .max(200)
        .refine((t) => t.startsWith(`${extensionId}.`), {
          message: `must start with ${extensionId}.`,
        }),
      key: z.string().max(500),
      timeoutAt: z.date().optional(),
    }),
  ]);
  return z.union([
    z.object({ exec: z.string().min(1).max(200), outputs: Outputs.optional() }),
    z.object({ wait: Wait, outputs: Outputs.optional() }),
  ]);
}

const MatchResult = z
  .object({ outputs: Outputs, concurrencyKey: z.string().max(500).optional() })
  .nullable();

const TestResultSchema = z.union([
  z.object({ ok: z.literal(true), detail: z.string().max(2_000).optional() }),
  z.object({ ok: z.literal(false), error: z.string().max(4_000) }),
]);

const ProvidedSandbox = z.object({
  externalId: z.string().min(1).max(500),
  detail: z.string().max(2_000).optional(),
});

const ListedSandboxes = z
  .array(
    z.object({ externalId: z.string().min(1).max(500), sandboxId: z.string().max(200).nullable() }),
  )
  .max(10_000);

function invalidResult(what: string, err: z.ZodError): NodeError {
  const detail = err.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "result"}: ${i.message}`)
    .join("; ");
  return new NodeError(`The extension returned an invalid ${what}: ${detail}`, {
    code: "invalid_result",
  });
}

/** What a node's run may return. Waits are limited to timers and the extension's own events. */
function checkNodeResult(extensionId: string, value: unknown): NodeResult {
  const r = nodeResultSchema(extensionId).safeParse(value);
  if (!r.success) {
    const wait = (value as { wait?: { kind?: unknown } } | null)?.wait;
    if (wait && wait.kind !== "timer" && wait.kind !== "event") {
      throw new NodeError(
        `An extension node can wait for a timer or an event, not ${String(wait.kind)}`,
        { code: "invalid_wait" },
      );
    }
    if (wait?.kind === "event") {
      throw new NodeError("A node can only wait for its extension's own events", {
        code: "invalid_wait",
      });
    }
    throw invalidResult("node result", r.error);
  }
  return r.data as NodeResult;
}

// ------------------------------------------------------------- description

const JsonObject = z.record(z.string(), z.unknown());
const Port = z.looseObject({ name: z.string().min(1).max(100), type: z.unknown() });
const ExecPort = z.looseObject({ name: z.string().min(1).max(100) });

const NodeDescriptionSchema = z.object({
  type: z.string().min(1).max(200),
  version: z.number().int().min(1).max(1_000),
  title: z.string().max(200),
  description: z.string().max(4_000),
  category: z.enum([
    "trigger",
    "logic",
    "data",
    "ai",
    "action",
    "state",
    "human",
    "agent",
    "composition",
  ]),
  inputs: z.array(Port).max(100),
  outputs: z.array(Port).max(100),
  execInput: z.boolean(),
  execOutputs: z.array(ExecPort).max(100),
  dynamicExecOutputs: z
    .object({
      fromConfig: z.string(),
      field: z.string().optional(),
      extra: z.array(ExecPort).optional(),
    })
    .nullable(),
  configSchema: JsonObject,
  expressionFields: z.array(z.string()).max(200),
  installationFields: z.array(z.string()).max(200),
  idempotent: z.boolean(),
  retry: z
    .object({ maxAttempts: z.number().int().min(1).max(100), backoffMs: z.number().min(0) })
    .nullable(),
  trigger: z.object({ event: z.string().min(1).max(200) }).nullable(),
  hasResume: z.boolean(),
  // Left out by extensions built on SDK 1.0.
  assistant: z
    .object({ sends: z.boolean(), summary: z.string().max(200).optional() })
    .nullable()
    .optional(),
});

const ConnectorDescriptionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  description: z.string().max(4_000),
  setupHelp: z.string().max(10_000).nullable(),
  credentialsSchema: JsonObject,
  secretFields: z.array(z.string().max(200)).max(100),
  configSchema: JsonObject,
  hasSource: z.boolean(),
  isExecutionProvider: z.boolean(),
  // Left out by extensions built on SDK 1.1 and older.
  hasSetup: z.boolean().optional(),
  nodes: z.array(NodeDescriptionSchema).max(500),
});

/** Checks the shape of what an extension's `describe()` returned. Names and permissions are checked by the caller. */
export const ExtensionDescriptionSchema = z.object({
  format: z.literal("sling.description/v1"),
  sdkVersion: z.string().max(50),
  connectors: z.array(ConnectorDescriptionSchema).max(100),
});

export function parseDescription(value: unknown): ExtensionDescription {
  const r = ExtensionDescriptionSchema.safeParse(value);
  if (!r.success) {
    const detail = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join(".") || "description"}: ${i.message}`)
      .join("; ");
    throw new Error(`The extension described itself in a form Sling can't read: ${detail}`);
  }
  return r.data as ExtensionDescription;
}

// ------------------------------------------------------------- connectors

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Plain fields of a node context: what the extension's code gets besides log, signal, and installation(). */
function nodeFields(ctx: NodeContext) {
  return {
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    nodeRunId: ctx.nodeRunId,
    workflowId: ctx.workflowId,
    workspaceId: ctx.workspaceId,
    ownerId: ctx.ownerId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    idempotencyKey: ctx.idempotencyKey,
  };
}

/** Builds the connectors an extension adds, each function calling into `version`'s process. */
export function buildConnectors(host: ExtensionHost, version: HostVersion): AnyConnector[] {
  const ext = version.ext;
  const own = new Set(ext.description.connectors.map((c) => c.id));

  /** Reads an installation for a running node, if its connector is one of this extension's. */
  function installationReader(ctx: NodeContext) {
    return async (id: string) => {
      // Through the engine, so the workspace is checked and the secrets get scrubbed.
      const inst = await ctx.installation(id);
      if (!own.has(inst.connectorId)) {
        throw new NodeError(
          `The extension ${ext.id} can't read installation ${id}: it belongs to ${inst.connectorId}`,
          { code: "installation_not_allowed" },
        );
      }
      return {
        id: inst.id,
        connectorId: inst.connectorId,
        name: inst.name,
        credentials: inst.credentials,
        config: inst.config,
      };
    };
  }

  function nodeSpec(c: ConnectorDescription, n: NodeDescription): AnyNodeSpec {
    const spec: AnyNodeSpec = {
      type: n.type,
      version: n.version,
      title: n.title,
      description: n.description,
      category: n.category,
      connector: c.id,
      configSchema: schemaFromJson(n.configSchema),
      expressionFields: n.expressionFields,
      installationFields: n.installationFields,
      inputs: n.inputs,
      outputs: n.outputs,
      execInput: n.execInput,
      execOutputs: n.execOutputs,
      idempotent: n.idempotent,
    };
    if (n.dynamicExecOutputs) spec.dynamicExecOutputs = n.dynamicExecOutputs;
    if (n.retry) spec.retry = n.retry;
    const use = assistantUse(n);
    if (use) spec.assistant = use;
    const call = async (
      method: "run" | "resume",
      ctx: NodeContext,
      extra: Record<string, unknown>,
    ): Promise<NodeResult> => {
      const scope: CallScope = {
        kind: "call",
        log: ctx.log,
        installation: installationReader(ctx),
      };
      const result = await host.call(
        version,
        method,
        { type: n.type, version: n.version, ctx: nodeFields(ctx), ...extra },
        { signal: ctx.signal, scope },
      );
      return checkNodeResult(ext.id, result);
    };
    if (n.trigger) {
      const event = n.trigger.event;
      spec.trigger = {
        event,
        match: async (ev, config): Promise<TriggerMatch | null> => {
          try {
            const r = MatchResult.safeParse(
              await host.call(version, "match", {
                type: n.type,
                version: n.version,
                event: ev,
                config,
              }),
            );
            if (!r.success) {
              host.addLine("warn", `The trigger ${n.type} returned an invalid match`);
              return null;
            }
            return r.data;
          } catch (err) {
            host.addLine("warn", `The trigger ${n.type} didn't match an event: ${errorText(err)}`);
            return null;
          }
        },
      };
    } else {
      spec.run = (ctx, { inputs, config }) => call("run", ctx, { inputs, config });
    }
    if (n.hasResume) {
      spec.resume = (ctx, { inputs, config, resolution }) =>
        call("resume", ctx, { inputs, config, resolution });
    }
    return spec;
  }

  function provider(c: ConnectorDescription): ExecutionProvider<unknown, unknown> {
    const fields = (pctx: ProviderContext<unknown, unknown>) => ({
      installationId: pctx.installationId,
      workspaceId: pctx.workspaceId,
      credentials: pctx.credentials,
      config: pctx.config,
    });
    const scope = (pctx: ProviderContext<unknown, unknown>): CallScope => ({
      kind: "call",
      log: pctx.log,
    });
    return {
      create: async (pctx, spec) => {
        const out = await host.call(
          version,
          "provider.create",
          { connector: c.id, ctx: fields(pctx), spec },
          { signal: pctx.signal, scope: scope(pctx) },
        );
        const r = ProvidedSandbox.safeParse(out);
        if (!r.success) throw invalidResult("sandbox", r.error);
        return r.data;
      },
      destroy: async (pctx, externalId) => {
        await host.call(
          version,
          "provider.destroy",
          { connector: c.id, ctx: fields(pctx), externalId },
          { signal: pctx.signal, scope: scope(pctx) },
        );
      },
      list: async (pctx) => {
        const out = await host.call(
          version,
          "provider.list",
          { connector: c.id, ctx: fields(pctx) },
          { signal: pctx.signal, scope: scope(pctx) },
        );
        const r = ListedSandboxes.safeParse(out);
        if (!r.success) throw invalidResult("sandbox list", r.error);
        return r.data;
      },
    };
  }

  function source(c: ConnectorDescription) {
    const events = new Set(c.nodes.flatMap((n) => (n.trigger ? [n.trigger.event] : [])));
    const approvals = ext.granted.approvals;
    const refuseApprovals = () =>
      new Error(`Sling refused: the extension ${ext.id} doesn't have the approvals permission`);
    return {
      start: async (ctx: SourceContext<unknown, unknown>) => {
        const scope: SourceScope = {
          kind: "source",
          log: ctx.log,
          emit: async (event) => {
            if (!events.has(event.type)) {
              const message = `Sling refused the event ${event.type}: none of ${c.id}'s triggers listen for it`;
              ctx.log.warn(message);
              throw new Error(message);
            }
            await ctx.emit(event);
          },
          stateGet: (key) => ctx.state.get(key),
          stateSet: (key, value) => ctx.state.set(key, value),
          decide: async (decision) => {
            if (!approvals) {
              host.addLine("error", `${refuseApprovals().message}, so it can't decide approvals`);
              throw refuseApprovals();
            }
            return ctx.approvals.decide(decision as Parameters<typeof ctx.approvals.decide>[0]);
          },
          reportRefused: async (decision) => {
            if (!approvals) throw refuseApprovals();
            await ctx.approvals.reportRefused(
              decision as Parameters<typeof ctx.approvals.reportRefused>[0],
            );
          },
          setStatus: (status, detail) => ctx.setStatus(status, detail),
        };
        const running = await host.startSource(
          version,
          {
            connector: c.id,
            installationId: ctx.installationId,
            workspaceId: ctx.workspaceId,
            credentials: ctx.credentials,
            config: ctx.config,
          },
          scope,
          ctx.signal,
        );
        return { stop: () => running.stop() };
      },
    };
  }

  return ext.description.connectors.map((c) => {
    const connector: AnyConnector = {
      id: c.id,
      name: c.name,
      description: c.description,
      credentialsSchema: schemaFromJson(c.credentialsSchema),
      secretFields: [...c.secretFields],
      configSchema: schemaFromJson(c.configSchema),
      test: async ({ credentials, config, log, signal }): Promise<TestResult> => {
        try {
          const out = await host.call(
            version,
            "test",
            { connector: c.id, credentials, config },
            { signal, scope: { kind: "call", log } },
          );
          const r = TestResultSchema.safeParse(out);
          return r.success
            ? r.data
            : { ok: false, error: "The extension's connection test returned an invalid result" };
        } catch (err) {
          return { ok: false, error: errorText(err) };
        }
      },
      nodes: c.nodes.map((n) => nodeSpec(c, n)),
    };
    if (c.setupHelp) connector.setupHelp = c.setupHelp;
    if (c.hasSetup) {
      connector.setup = async ({ credentials, config, log, signal }) =>
        parseSetupResult(
          await host.call(
            version,
            "setup",
            { connector: c.id, credentials, config },
            { signal, scope: { kind: "call", log } },
          ),
        );
    }
    if (c.hasSource) connector.source = source(c);
    // A provider sees every sandbox's secrets, so it needs the permission the owner granted.
    if (c.isExecutionProvider && ext.granted.sandboxes) connector.executionProvider = provider(c);
    return connector;
  });
}
