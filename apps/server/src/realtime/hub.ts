import { randomUUID } from "node:crypto";
import type { ClientEvent, ServerEvent } from "@sling/core";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.ts";
import { actorFromHeaders } from "../http/session.ts";

type Listener = (workspaceId: string, event: ServerEvent) => void;

/**
 * Fans server events out to every open browser tab in a workspace, and to
 * listeners in the server that act on them, such as push notifications.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

export class Hub {
  #lastErrorAt = 0;
  readonly onError: (err: unknown) => void;
  constructor(onError: (err: unknown) => void = () => {}) {
    this.onError = onError;
  }
  readonly #sockets = new Map<string, Set<WebSocket>>();
  readonly #listeners = new Set<Listener>();

  /** Hears every event, open tabs or not. It runs inline, so it must return fast. */
  listen(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  add(workspaceId: string, socket: WebSocket) {
    let set = this.#sockets.get(workspaceId);
    if (!set) {
      set = new Set();
      this.#sockets.set(workspaceId, set);
    }
    set.add(socket);
    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0 && this.#sockets.get(workspaceId) === set) {
        this.#sockets.delete(workspaceId);
      }
    });
  }

  publish(workspaceId: string, event: ServerEvent) {
    for (const fn of this.#listeners) {
      try {
        fn(workspaceId, event);
      } catch (err) {
        if (Date.now() - this.#lastErrorAt > 10_000) {
          this.#lastErrorAt = Date.now();
          this.onError(err);
        }
      }
    }
    const set = this.#sockets.get(workspaceId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(event);
    for (const socket of set) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
        socket.terminate();
        continue;
      }
      try {
        socket.send(data, (err) => {
          if (err) socket.terminate();
        });
      } catch {
        socket.terminate();
      }
    }
  }

  /** Workspaces with at least one open tab. */
  workspaces(): string[] {
    const out: string[] = [];
    for (const [id, set] of this.#sockets) if (set.size > 0) out.push(id);
    return out;
  }

  get connections(): number {
    let n = 0;
    for (const set of this.#sockets.values()) n += set.size;
    return n;
  }
}

export async function hubRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/ws", { websocket: true }, async (socket, request) => {
    // Browsers send Origin on WebSocket upgrades. Refuse other sites.
    if (request.headers.origin !== ctx.config.publicUrl.origin) {
      socket.close(4403, "bad origin");
      return;
    }
    // The web app speaks as soon as the socket opens, before the session check
    // below finishes, so early messages wait here instead of being dropped.
    const early: string[] = [];
    let onMessage = (text: string) => {
      if (early.length < 8) early.push(text);
    };
    socket.on("message", (raw) => onMessage(raw.toString()));
    const actor = await actorFromHeaders(ctx, request.headers);
    if (!actor) {
      socket.close(4401, "unauthorized");
      return;
    }
    ctx.hub.add(actor.workspaceId, socket);
    const socketId = randomUUID();
    onMessage = (text) => {
      if (text === "ping") {
        socket.send('{"type":"pong"}');
        return;
      }
      const event = clientEvent(text);
      if (event) ctx.push.presence(socketId, actor.userId, event);
    };
    for (const text of early.splice(0)) onMessage(text);
    socket.on("close", () => ctx.push.socketClosed(socketId));
  });
}

/** A message from the web app, or null for anything that isn't one. */
export function clientEvent(text: string): ClientEvent | null {
  if (text.length > 512 || !text.startsWith("{")) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.type !== "presence" || typeof o.visible !== "boolean") return null;
  const id = o.conversationId;
  if (id !== null && (typeof id !== "string" || id.length === 0 || id.length > 64)) return null;
  return { type: "presence", conversationId: id, visible: o.visible };
}
