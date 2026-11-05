import { createPublicKey, randomBytes, verify } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import {
  authPayload,
  create,
  decodeEnvelope,
  type Envelope,
  EnvelopeSchema,
  Error_Code,
  type Hello,
  type Inventory,
  MAX_CLOCK_SKEW_MS,
  RUNNER_WS_PATH,
  type TaskEvent,
} from "@sling/runner-protocol";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.ts";
import { runnerView } from "../views.ts";
import { modeFromProto } from "./convert.ts";

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
}

export function ed25519KeyFromRaw(raw: Buffer) {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export class RunnerGateway {
  readonly #sessions = new Map<string, RunnerSession>();
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
          if (!session) {
            if (envelope.body.case !== "hello") return fail(Error_Code.PROTOCOL, "expected hello");
            session = await this.#authenticate(envelope.body.value, nonce, send, socket, fail);
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
      queue = queue.then(async () => {
        await this.#ctx.db
          .update(schema.runners)
          .set({ online: false, lastSeenAt: new Date() })
          .where(eq(schema.runners.id, s.runnerId));
        await this.handlers?.disconnected(s);
        await this.#publishRunner(s);
        log.info({ runnerId: s.runnerId }, "runner disconnected");
      });
    });
  }

  async #authenticate(
    hello: Hello,
    nonce: Buffer,
    send: (e: Envelope) => boolean,
    socket: WebSocket,
    fail: (code: Error_Code, message: string) => void,
  ): Promise<RunnerSession | null> {
    const [runner] = await this.#ctx.db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, hello.runnerId));
    if (!runner) {
      fail(Error_Code.UNKNOWN_RUNNER, "unknown runner");
      return null;
    }
    if (runner.revokedAt) {
      fail(Error_Code.REVOKED, "this runner was revoked");
      return null;
    }
    if (Math.abs(Number(hello.timestampMs) - Date.now()) > MAX_CLOCK_SKEW_MS) {
      fail(Error_Code.CLOCK_SKEW, "clock skew too large");
      return null;
    }
    const ok = verify(
      null,
      authPayload(nonce, hello.runnerId, hello.timestampMs),
      ed25519KeyFromRaw(Buffer.from(runner.publicKey, "base64")),
      hello.signature,
    );
    if (!ok) {
      fail(Error_Code.BAD_SIGNATURE, "bad signature");
      return null;
    }

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
    return session;
  }

  async #handle(session: RunnerSession, envelope: Envelope) {
    switch (envelope.body.case) {
      case "heartbeat":
        session.send(create(EnvelopeSchema, { body: { case: "heartbeatAck", value: {} } }));
        return;
      case "inventory":
        await this.#applyInventory(session, envelope.body.value);
        await this.#publishRunner(session);
        return;
      case "taskEvent":
        await this.handlers?.taskEvent(session, envelope.body.value);
        return;
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
        })),
        maxMode: modeFromProto(inv.maxMode),
        maxConcurrentTasks: Math.max(1, Math.min(inv.maxConcurrentTasks || 1, 16)),
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
          network: repo.network,
        })
        .onConflictDoUpdate({
          target: [schema.repos.runnerId, schema.repos.name],
          set: {
            defaultBranch: repo.defaultBranch || "main",
            remoteUrl: repo.remoteUrl,
            network: repo.network,
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
