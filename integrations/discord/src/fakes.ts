/** Fakes for the gateway, REST, and the contexts the server provides. Tests only. */
import type {
  ApprovalDecision,
  Installation,
  NodeContext,
  NodeLogger,
  SourceContext,
  SourceStatus,
} from "@sling/connector-sdk";
import type { ActionRow } from "./approval.ts";
import type {
  ButtonClick,
  DiscordGateway,
  GatewayFactory,
  GatewayHandlers,
  GatewayMessage,
} from "./gateway.ts";
import type { DiscordRest, RestResponse } from "./rest.ts";
import type { DiscordConfig, DiscordCredentials } from "./schemas.ts";

export const BOT_ID = "900000000000000001";
export const ALICE = "100000000000000001";
export const BOB = "100000000000000002";
export const CHANNEL = "300000000000000001";
export const GUILD = "400000000000000001";

export const silentLog: NodeLogger = { info() {}, warn() {}, error() {} };

export interface RecordedRequest {
  token: string;
  method: string;
  path: string;
  body: unknown;
}

/** REST that answers from a table keyed by "METHOD /path", and records every call. */
export function fakeRest(routes: Record<string, RestResponse | ((body: unknown) => RestResponse)>) {
  const requests: RecordedRequest[] = [];
  const factory = (token: string): DiscordRest => ({
    async request(method, path, body) {
      requests.push({ token, method, path, body });
      const route = routes[`${method} ${path}`];
      if (!route) return { status: 404, body: { code: 0, message: "404: Not Found" } };
      return typeof route === "function" ? route(body) : route;
    },
  });
  return { factory, requests };
}

export interface FakeClick extends ButtonClick {
  calls: string[];
  ephemeral: string[];
  edits: { content: string; components: ActionRow[] }[];
}

export function fakeClick(customId: string, userId: string, content = "Approve this?"): FakeClick {
  const calls: string[] = [];
  const ephemeral: string[] = [];
  const edits: { content: string; components: ActionRow[] }[] = [];
  return {
    customId,
    user: { id: userId, username: `user-${userId.slice(-1)}` },
    message: { id: "500000000000000001", channelId: CHANNEL, content },
    calls,
    ephemeral,
    edits,
    async acknowledge() {
      calls.push("acknowledge");
    },
    async replyEphemeral(text) {
      calls.push("replyEphemeral");
      ephemeral.push(text);
    },
    async editMessage(edit) {
      calls.push("editMessage");
      edits.push(edit);
    },
  };
}

/** A gateway the test drives by hand. Each connection attempt makes a new instance. */
export class FakeGateways {
  instances: FakeGateway[] = [];
  /** Login outcomes for successive connection attempts; afterwards logins succeed. */
  loginErrors: (Error | null)[] = [];

  factory: GatewayFactory = (handlers) => {
    const gateway = new FakeGateway(handlers, this.loginErrors.shift() ?? null);
    this.instances.push(gateway);
    return gateway;
  };

  get latest(): FakeGateway {
    const g = this.instances.at(-1);
    if (!g) throw new Error("no gateway yet");
    return g;
  }
}

export class FakeGateway implements DiscordGateway {
  handlers: GatewayHandlers;
  loginError: Error | null;
  token: string | null = null;
  destroyed = false;
  loggedIn = false;

  constructor(handlers: GatewayHandlers, loginError: Error | null) {
    this.handlers = handlers;
    this.loginError = loginError;
  }

  async login(token: string) {
    this.token = token;
    if (this.loginError) throw this.loginError;
    this.loggedIn = true;
    return { botUserId: BOT_ID, username: "sling-bot" };
  }

  async destroy() {
    this.destroyed = true;
  }

  send(message: Partial<GatewayMessage> & { authorId?: string }) {
    const { authorId, ...rest } = message;
    this.handlers.message({
      id: "600000000000000001",
      channelId: CHANNEL,
      guildId: null,
      author: { id: authorId ?? ALICE, username: "alice", bot: false },
      system: false,
      content: "hello",
      mentionedUserIds: [],
      mentionedRoleIds: [],
      botRoleId: null,
      createdAt: new Date("2026-11-05T10:00:00.000Z"),
      ...rest,
    });
  }
}

export interface FakeSourceContext extends SourceContext<DiscordCredentials, DiscordConfig> {
  emitted: { type: string; payload: unknown; dedupeKey?: string }[];
  statuses: { status: SourceStatus; detail?: string }[];
  decisions: ApprovalDecision[];
  refused: (ApprovalDecision & { reason: string })[];
  controller: AbortController;
}

export function fakeSourceContext(
  config: Partial<DiscordConfig> = {},
  decide: (d: ApprovalDecision) => Promise<{ ok: boolean; message: string }> = async () => ({
    ok: true,
    message: "Approved",
  }),
): FakeSourceContext {
  const controller = new AbortController();
  const emitted: FakeSourceContext["emitted"] = [];
  const statuses: FakeSourceContext["statuses"] = [];
  const decisions: ApprovalDecision[] = [];
  const refused: FakeSourceContext["refused"] = [];
  const state = new Map<string, string>();
  return {
    installationId: "inst_discord",
    workspaceId: "ws_1",
    credentials: { botToken: "token-abc" },
    config: { allowedUserIds: [ALICE], approverUserIds: [ALICE], ...config },
    log: silentLog,
    signal: controller.signal,
    controller,
    emitted,
    statuses,
    decisions,
    refused,
    async emit(event) {
      emitted.push(event);
    },
    state: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async set(key, value) {
        state.set(key, value);
      },
    },
    approvals: {
      async decide(decision) {
        decisions.push(decision);
        return decide(decision);
      },
      async reportRefused(decision) {
        refused.push(decision);
      },
    },
    setStatus(status, detail) {
      statuses.push({ status, detail });
    },
  };
}

export function fakeNodeContext(
  installation: Partial<Installation<DiscordCredentials, Partial<DiscordConfig>>> = {},
  overrides: Partial<NodeContext> = {},
): NodeContext {
  const inst: Installation = {
    id: "inst_discord",
    connectorId: "discord",
    name: "My bot",
    credentials: { botToken: "token-abc" },
    config: { allowedUserIds: [], approverUserIds: [] },
    ...installation,
  } as Installation;
  return {
    runId: "run_1",
    nodeId: "n_send",
    nodeRunId: "nr_1",
    workflowId: "wf_1",
    workspaceId: "ws_1",
    ownerId: "user_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey: "run_1:n_send:0",
    signal: new AbortController().signal,
    log: silentLog,
    async installation<C, Cfg>(id: string) {
      if (id !== inst.id) throw new Error(`no installation ${id}`);
      return inst as unknown as Installation<C, Cfg>;
    },
    services: undefined,
    ...overrides,
  };
}

/** Waits until `check` passes, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
