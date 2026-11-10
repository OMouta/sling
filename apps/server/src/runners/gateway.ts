import { createPublicKey, randomBytes, verify } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import {
  AGENT_MODEL_PATTERN,
  type AgentModelView,
  CHANNEL_KINDS,
  type ChannelKind,
  type ChannelView,
  EFFORT_PATTERN,
  newId,
  remoteKey,
} from "@sling/core";
import { schema } from "@sling/db";
import {
  type AgentModel,
  authPayload,
  type Channel,
  create,
  decodeEnvelope,
  type Envelope,
  EnvelopeSchema,
  Error_Code,
  type Hello,
  type Inventory,
  MAX_CLOCK_SKEW_MS,
  RepoChange_Op,
  RUNNER_WS_PATH,
  type TaskEvent,
} from "@sling/runner-protocol";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.ts";
import { runnerView } from "../views.ts";
import { modeFromProto } from "./convert.ts";
import { normalizeLabels } from "./labels.ts";

export const HEARTBEAT_SECONDS = 15;
const OFFLINE_AFTER_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;

export interface RunnerSession {
  runnerId: string;
  workspaceId: string;
  ownerId: string;
  connectedAt: number;
  lastMessageAt: number;
  send(envelope: Envelope): boolean;
  close(code: number, reason: string): void;
}

/** Implemented by the task service. */
export interface GatewayHandlers {
  /** Returns task IDs the Runner can forget. Runs before Welcome is sent. */
  connected(session: RunnerSession, hello: Hello): Promise<string[]>;
  /** Runs after Welcome. Safe to send tasks and actions from here. */
  ready(session: RunnerSession, hello: Hello): Promise<void>;
  disconnected(session: RunnerSession): Promise<void>;
  taskEvent(session: RunnerSession, event: TaskEvent): Promise<void>;
  /** The Runner sent a new inventory after connecting. */
  inventoryUpdated?(session: RunnerSession): Promise<void>;
}

export function ed25519KeyFromRaw(raw: Buffer) {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export class RunnerGateway {
  readonly #sessions = new Map<string, RunnerSession>();

  /** Runners connected to this process right now. */
  get connectedCount(): number {
    return this.#sessions.size;
  }
  /** Repo changes sent to a Runner and waiting for its RepoChangeResult. */
  readonly #repoChanges = new Map<
    string,
    { runnerId: string; resolve: (r: { ok: boolean; message: string }) => void }
  >();
  readonly #ctx: AppContext;
  handlers: GatewayHandlers | null = null;
  #sweeper: NodeJS.Timeout | null = null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  isOnline(runnerId: string): boolean {
    return this.#sessions.has(runnerId);
  }

  send(runnerId: string, envelope: Envelope): boolean {
    return this.#sessions.get(runnerId)?.send(envelope) ?? false;
  }

  /**
   * Asks a Runner to allow one of its found repos, or to stop allowing one.
   * The Runner decides: it refuses when the machine turned this off, and adds
   * only paths it found itself.
   */
  changeRepo(
    runnerId: string,
    change:
      | { op: "add"; path: string; name?: string }
      | { op: "add-many"; paths: string[] }
      | { op: "remove"; name: string },
    timeoutMs = 15_000,
  ): Promise<{ ok: boolean; message: string }> {
    const requestId = newId("rqc");
    const value =
      change.op === "add"
        ? { requestId, op: RepoChange_Op.ADD, path: change.path, name: change.name ?? "" }
        : change.op === "add-many"
          ? { requestId, op: RepoChange_Op.ADD, path: "", name: "", paths: change.paths }
          : { requestId, op: RepoChange_Op.REMOVE, path: "", name: change.name };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#repoChanges.delete(requestId);
        resolve({ ok: false, message: "The machine didn't answer in time." });
      }, timeoutMs);
      this.#repoChanges.set(requestId, {
        runnerId,
        resolve: (r) => {
          clearTimeout(timer);
          this.#repoChanges.delete(requestId);
          resolve(r);
        },
      });
      const sent = this.send(
        runnerId,
        create(EnvelopeSchema, { body: { case: "repoChange", value } }),
      );
      if (!sent)
        this.#repoChanges
          .get(requestId)
          ?.resolve({ ok: false, message: "The machine is offline." });
    });
  }

  /** Asks a Runner to look for repos again. Its fresh inventory arrives as usual. */
  scanRepos(runnerId: string): boolean {
    return this.send(runnerId, create(EnvelopeSchema, { body: { case: "repoScan", value: {} } }));
  }

  /** Sends an Error and closes the connection, for example on revoke. */
  disconnect(runnerId: string, code: Error_Code, message: string) {
    const session = this.#sessions.get(runnerId);
    if (!session) return;
    session.send(create(EnvelopeSchema, { body: { case: "error", value: { code, message } } }));
    session.close(4001, message);
  }

  start() {
    this.#sweeper = setInterval(() => {
      const cutoff = Date.now() - OFFLINE_AFTER_MS;
      for (const session of this.#sessions.values()) {
        if (session.lastMessageAt < cutoff) session.close(4008, "heartbeat timeout");
      }
    }, 5_000);
    this.#sweeper.unref();
  }

  readonly closing = new Set<Promise<void>>();
  async idle() {
    await Promise.all(this.closing);
  }

  stop() {
    if (this.#sweeper) clearInterval(this.#sweeper);
    for (const session of this.#sessions.values()) session.close(1001, "server shutting down");
  }

  register(app: FastifyInstance) {
    app.get(RUNNER_WS_PATH, { websocket: true }, (socket) => this.#accept(socket));
  }

  #accept(socket: WebSocket) {
    const log = this.#ctx.log.child({ component: "runner-gateway" });
    const nonce = randomBytes(32);
    let session: RunnerSession | null = null;
    /** Set when connecting failed after the session was registered. Later frames are dropped. */
    let broken = false;
    let queue: Promise<void> = Promise.resolve();

    const send = (envelope: Envelope) => {
      if (socket.readyState !== socket.OPEN) return false;
      socket.send(toBinary(EnvelopeSchema, envelope));
      return true;
    };
    const fail = (code: Error_Code, message: string) => {
      send(create(EnvelopeSchema, { body: { case: "error", value: { code, message } } }));
      socket.close(4001, message);
    };

    const helloTimer = setTimeout(() => {
      if (!session) fail(Error_Code.PROTOCOL, "no hello");
    }, HELLO_TIMEOUT_MS);

    send(create(EnvelopeSchema, { body: { case: "challenge", value: { nonce } } }));

    socket.on("message", (data, isBinary) => {
      if (!isBinary) return fail(Error_Code.PROTOCOL, "binary frames only");
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(new Uint8Array(data as Buffer));
      } catch {
        return fail(Error_Code.PROTOCOL, "bad frame");
      }
      // Handle frames strictly in order so task events keep their sequence.
      queue = queue
        .then(async () => {
          if (broken) return;
          if (!session) {
            if (envelope.body.case !== "hello") return fail(Error_Code.PROTOCOL, "expected hello");
            const hello = envelope.body.value;
            try {
              await this.#authenticate(hello, nonce, send, socket, fail, (s) => {
                session = s;
              });
            } catch (err) {
              // The close handler unregisters the session and marks the machine offline.
              broken = true;
              log.error({ err, runnerId: hello.runnerId }, "runner connect failed");
              fail(Error_Code.UNSPECIFIED, "The server couldn't finish connecting this machine.");
            }
            clearTimeout(helloTimer);
            return;
          }
          session.lastMessageAt = Date.now();
          await this.#handle(session, envelope);
        })
        .catch((err) => log.error({ err }, "runner frame failed"));
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      const s = session;
      if (!s || this.#sessions.get(s.runnerId) !== s) return;
      this.#sessions.delete(s.runnerId);
      queue = queue
        .then(async () => {
          // The Runner may have reconnected while this connection's last frames
          // were handled. The new connection owns its state then, as when it
          // replaces a live one, and marking it offline here would undo that.
          if (this.#sessions.has(s.runnerId)) return;
          await this.#ctx.db
            .update(schema.runners)
            .set({ online: false, lastSeenAt: new Date() })
            .where(eq(schema.runners.id, s.runnerId));
          this.#ctx.cliChat?.runnerDisconnected(s.runnerId);
          this.#ctx.commands?.runnerDisconnected(s.runnerId);
          await this.handlers?.disconnected(s);
          await this.#publishRunner(s);
          log.info({ runnerId: s.runnerId }, "runner disconnected");
        })
        .catch((err) => log.error({ err }, "runner disconnect failed"));
      const closing = queue.finally(() => this.closing.delete(closing));
      this.closing.add(closing);
    });
  }

  async #authenticate(
    hello: Hello,
    nonce: Buffer,
    send: (e: Envelope) => boolean,
    socket: WebSocket,
    fail: (code: Error_Code, message: string) => void,
    registered: (session: RunnerSession) => void,
  ): Promise<void> {
    const [runner] = await this.#ctx.db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, hello.runnerId));
    if (!runner) {
      fail(Error_Code.UNKNOWN_RUNNER, "unknown runner");
      return;
    }
    if (runner.revokedAt) {
      fail(Error_Code.REVOKED, "this runner was revoked");
      return;
    }
    if (Math.abs(Number(hello.timestampMs) - Date.now()) > MAX_CLOCK_SKEW_MS) {
      fail(Error_Code.CLOCK_SKEW, "clock skew too large");
      return;
    }
    const ok = verify(
      null,
      authPayload(nonce, hello.runnerId, hello.timestampMs),
      ed25519KeyFromRaw(Buffer.from(runner.publicKey, "base64")),
      hello.signature,
    );
    if (!ok) {
      fail(Error_Code.BAD_SIGNATURE, "bad signature");
      return;
    }

    // Closed while the runner was looked up: there's no connection to register.
    if (socket.readyState !== socket.OPEN) return;
    const session: RunnerSession = {
      runnerId: runner.id,
      workspaceId: runner.workspaceId,
      ownerId: runner.ownerId,
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      send,
      close: (code, reason) => socket.close(code, reason),
    };
    // One connection per Runner. A newer one replaces the old.
    this.#sessions.get(runner.id)?.close(4009, "replaced by a newer connection");
    this.#sessions.set(runner.id, session);
    registered(session);

    await this.#ctx.db
      .update(schema.runners)
      .set({
        online: true,
        lastSeenAt: new Date(),
        version: hello.runnerVersion,
        os: hello.os,
        arch: hello.arch,
        hostname: hello.hostname,
      })
      .where(eq(schema.runners.id, runner.id));
    if (hello.inventory) await this.#applyInventory(session, hello.inventory);

    const forget = (await this.handlers?.connected(session, hello)) ?? [];
    send(
      create(EnvelopeSchema, {
        body: {
          case: "welcome",
          value: {
            serverTimeMs: BigInt(Date.now()),
            heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
            forgetTaskIds: forget,
          },
        },
      }),
    );
    await this.#publishRunner(session);
    this.#ctx.log.info({ runnerId: runner.id }, "runner connected");
    await this.handlers?.ready(session, hello);
    this.#ctx.channels?.runnerConnected(session);
  }

  async #handle(session: RunnerSession, envelope: Envelope) {
    switch (envelope.body.case) {
      case "heartbeat":
        session.send(create(EnvelopeSchema, { body: { case: "heartbeatAck", value: {} } }));
        return;
      case "inventory":
        await this.#applyInventory(session, envelope.body.value);
        await this.#publishRunner(session);
        await this.handlers?.inventoryUpdated?.(session);
        return;
      case "taskEvent":
        await this.handlers?.taskEvent(session, envelope.body.value);
        return;
      case "chatEvent":
        this.#ctx.cliChat?.handleEvent(session, envelope.body.value);
        return;
      case "execResult":
        this.#ctx.commands?.handleResult(session, envelope.body.value);
        return;
      case "repoActionOutput":
        await this.#ctx.deploys?.repoActionOutput(session, envelope.body.value);
        return;
      case "repoActionResult":
        await this.#ctx.deploys?.repoActionResult(session, envelope.body.value);
        return;
      case "fileSearchResult":
        this.#ctx.files?.searchResult(session, envelope.body.value);
        return;
      case "fileReadResult":
        this.#ctx.files?.readResult(session, envelope.body.value);
        return;
      case "channelMessage":
        await this.#ctx.channels?.message(session, envelope.body.value);
        return;
      case "channelSendResult":
        this.#ctx.channels?.sendResult(session, envelope.body.value);
        return;
      case "repoChangeResult": {
        const r = envelope.body.value;
        const pending = this.#repoChanges.get(r.requestId);
        if (pending?.runnerId === session.runnerId) {
          pending.resolve({ ok: r.ok, message: r.message.slice(0, 500) });
        }
        return;
      }
      default:
        return;
    }
  }

  async #applyInventory(session: RunnerSession, inv: Inventory) {
    const db = this.#ctx.db;
    await db
      .update(schema.runners)
      .set({
        capabilities: inv.capabilities.map((c) => ({
          name: c.name,
          version: c.version,
          ready: c.ready,
          detail: c.detail,
          ...(c.models.length ? { models: agentModels(c.models) } : {}),
        })),
        foundRepos: inv.foundRepos.slice(0, 300).map((f) => ({
          path: f.path.slice(0, 1024),
          name: f.name.slice(0, 120),
          defaultBranch: f.defaultBranch.slice(0, 200),
          remoteUrl: f.remoteUrl.slice(0, 1024),
        })),
        remoteRepos: inv.remoteRepos,
        deploys: inv.deploys,
        folders: folderNames(inv.folders),
        files: inv.files,
        channels: channelViews(inv.channels),
        maxMode: modeFromProto(inv.maxMode),
        maxConcurrentTasks: Math.max(1, Math.min(inv.maxConcurrentTasks || 1, 16)),
        labels: normalizeLabels(inv.labels),
      })
      .where(eq(schema.runners.id, session.runnerId));

    const names = inv.repos.map((r) => r.name);
    for (const repo of inv.repos) {
      await db
        .insert(schema.repos)
        .values({
          id: newId("rpo"),
          workspaceId: session.workspaceId,
          ownerId: session.ownerId,
          runnerId: session.runnerId,
          name: repo.name,
          defaultBranch: repo.defaultBranch || "main",
          remoteUrl: repo.remoteUrl,
          remoteKey: remoteKey(repo.remoteUrl),
          network: repo.network,
          deployCommand: repo.deployCommand.slice(0, 2000),
          deployTimeoutSeconds: deployTimeout(repo.deployTimeoutSeconds),
        })
        .onConflictDoUpdate({
          target: [schema.repos.runnerId, schema.repos.name],
          set: {
            defaultBranch: repo.defaultBranch || "main",
            remoteUrl: repo.remoteUrl,
            remoteKey: remoteKey(repo.remoteUrl),
            network: repo.network,
            deployCommand: repo.deployCommand.slice(0, 2000),
            deployTimeoutSeconds: deployTimeout(repo.deployTimeoutSeconds),
            removedAt: null,
          },
        });
    }
    const stale = and(
      eq(schema.repos.runnerId, session.runnerId),
      isNull(schema.repos.removedAt),
      names.length ? notInArray(schema.repos.name, names) : undefined,
    );
    await db.update(schema.repos).set({ removedAt: new Date() }).where(stale);
  }

  async #publishRunner(session: RunnerSession) {
    const view = await runnerView(this.#ctx, session.runnerId);
    if (view) this.#ctx.hub.publish(session.workspaceId, { type: "runner.updated", runner: view });
  }
}

/** Agent models as the Runner reports them, bounded and limited to safe IDs. */
function agentModels(models: AgentModel[]): AgentModelView[] {
  const effort = (e: string) => EFFORT_PATTERN.test(e);
  return models
    .filter((m) => AGENT_MODEL_PATTERN.test(m.id))
    .slice(0, 50)
    .map((m) => ({
      id: m.id,
      displayName: (m.displayName || m.id).slice(0, 80),
      description: m.description.slice(0, 300),
      efforts: m.efforts.filter(effort).slice(0, 10),
      defaultEffort: effort(m.defaultEffort) ? m.defaultEffort : "",
      fast: m.fast,
      isDefault: m.isDefault,
    }));
}

/** Shared folder names as the Runner reports them, bounded. */
function folderNames(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().slice(0, 120)).filter(Boolean))].slice(0, 100);
}

/** Channels as the Runner reports them, bounded, and only of kinds Sling knows. */
function channelViews(channels: Channel[]): ChannelView[] {
  return channels
    .filter((c): c is Channel & { kind: ChannelKind } =>
      (CHANNEL_KINDS as readonly string[]).includes(c.kind),
    )
    .slice(0, 20)
    .map((c) => ({
      kind: c.kind,
      name: c.name.slice(0, 80),
      allowedSenders: c.allowedSenders,
      ready: c.ready,
      missing: c.missing.slice(0, 300),
    }));
}

/** A Runner that doesn't say gets the Runner's default of 15 minutes; a day at most. */
function deployTimeout(seconds: number): number {
  return seconds > 0 ? Math.min(seconds, 24 * 60 * 60) : 900;
}
