import type { ServerEvent } from "@sling/core";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.ts";
import { actorFromHeaders } from "../http/session.ts";

/** Fans server events out to every open browser tab in a workspace. */
export class Hub {
  readonly #sockets = new Map<string, Set<WebSocket>>();

  add(workspaceId: string, socket: WebSocket) {
    let set = this.#sockets.get(workspaceId);
    if (!set) {
      set = new Set();
      this.#sockets.set(workspaceId, set);
    }
    set.add(socket);
    socket.on("close", () => set.delete(socket));
  }

  publish(workspaceId: string, event: ServerEvent) {
    const set = this.#sockets.get(workspaceId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(event);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(data);
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
    const actor = await actorFromHeaders(ctx, request.headers);
    if (!actor) {
      socket.close(4401, "unauthorized");
      return;
    }
    ctx.hub.add(actor.workspaceId, socket);
    socket.on("message", (raw) => {
      if (raw.toString() === "ping") socket.send('{"type":"pong"}');
    });
  });
}
