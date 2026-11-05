/**
 * What a connector provides: credential and config schemas, a connection test,
 * workflow nodes, and optionally a long-running event source. Connectors live
 * in `integrations/<id>` and are registered by the server.
 */
import type { AnyNodeSpec, NodeLogger } from "@sling/workflow";
import type { z } from "zod";

export type TestResult = { ok: true; detail?: string } | { ok: false; error: string };

export interface ConnectorDefinition<
  Credentials = Record<string, unknown>,
  Config = Record<string, unknown>,
> {
  id: string;
  name: string;
  description: string;
  /** Where to get credentials, shown next to the form. */
  setupHelp?: string;
  /** Stored encrypted as one blob. Never sent back to the browser. */
  credentialsSchema: z.ZodType<Credentials>;
  /** Credential keys to render as password fields. */
  secretFields: string[];
  /** Plain settings such as allowed users or a default channel. Visible in the UI. */
  configSchema: z.ZodType<Config>;
  test(ctx: {
    credentials: Credentials;
    config: Config;
    log: NodeLogger;
    signal: AbortSignal;
  }): Promise<TestResult>;
  nodes: AnyNodeSpec[];
  source?: EventSourceFactory<Credentials, Config>;
}

export type SourceStatus = "connecting" | "connected" | "error";

export interface ApprovalDecision {
  approvalId: string;
  approve: boolean;
  /** Who decided, outside Sling. For example `{ via: "discord", externalUserId: "1234" }`. */
  actor: { via: string; externalUserId: string };
}

export interface SourceContext<Credentials, Config> {
  installationId: string;
  workspaceId: string;
  credentials: Credentials;
  config: Config;
  log: NodeLogger;
  /** Aborted when the server stops the source. */
  signal: AbortSignal;
  /**
   * Hands an event to the workflow engine, which offers it to every matching
   * trigger. `dedupeKey` makes repeat emits of the same event a no-op.
   */
  emit(event: { type: string; payload: unknown; dedupeKey?: string }): Promise<void>;
  /** Small persistent store per installation, for cursors such as IMAP UIDs. */
  state: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  /**
   * Decides a Sling approval on behalf of an external user. The connector is
   * responsible for checking that the user is allowed; the server checks the
   * approval is pending and in this workspace, and audits the decision.
   */
  approvals: {
    decide(decision: ApprovalDecision): Promise<{ ok: boolean; message: string }>;
  };
  setStatus(status: SourceStatus, detail?: string): void;
}

export interface EventSource {
  stop(): Promise<void>;
}

export interface EventSourceFactory<Credentials, Config> {
  start(ctx: SourceContext<Credentials, Config>): Promise<EventSource>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds connectors of every shape.
export type AnyConnector = ConnectorDefinition<any, any>;

export function defineConnector<Credentials, Config>(
  def: ConnectorDefinition<Credentials, Config>,
): ConnectorDefinition<Credentials, Config> {
  return def;
}
