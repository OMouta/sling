/**
 * Requests in both directions over one channel. Each side numbers its own
 * requests, so an ID in a result or a cancel always refers to the receiver's
 * own request (for "r", "e") or to the sender's (for "x").
 *
 * Frames:
 *   { t: "q", id, m, p }   request: method and params
 *   { t: "r", id, v }      result
 *   { t: "e", id, e }      error: { name, message, code?, retryable? }
 *   { t: "x", id }         cancel a request the sender made
 *   { t: "n", m, p }       notification, no answer
 *   { t: "ping" }, { t: "pong" }, { t: "ready", ... }, { t: "fatal", e }
 */

/**
 * @typedef {{ name: string, message: string, code?: string, retryable?: boolean, permission?: string, resource?: string }} WireError
 * @typedef {(method: string, params: any, signal: AbortSignal) => Promise<unknown>} RequestHandler
 * @typedef {(method: string, params: any) => void} NoteHandler
 */

const MAX_ERROR_MESSAGE = 4000;

/**
 * Plain fields of an error, for sending.
 * @param {unknown} err
 * @returns {WireError}
 */
export function toWireError(err) {
  const e = /** @type {Record<string, unknown>} */ (
    err !== null && typeof err === "object" ? err : { message: String(err) }
  );
  /** @type {WireError} */
  const out = {
    name: typeof e.name === "string" ? e.name : "Error",
    message: String(e.message ?? "").slice(0, MAX_ERROR_MESSAGE),
  };
  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.retryable === "boolean") out.retryable = e.retryable;
  if (typeof e.permission === "string") out.permission = e.permission;
  if (typeof e.resource === "string") out.resource = e.resource;
  return out;
}

export class Peer {
  /** @type {(frame: Record<string, unknown>) => void} */
  #send;
  /** @type {RequestHandler} */
  #onRequest;
  /** @type {NoteHandler} */
  #onNote;
  #nextId = 1;
  /** Requests this side made. @type {Map<number, { resolve: (v: unknown) => void, reject: (e: unknown) => void, cleanup: () => void }>} */
  #pending = new Map();
  /** Requests the other side made that are still running. @type {Map<number, AbortController>} */
  #incoming = new Map();
  /** @type {(err: WireError) => unknown} */
  #toError;

  /**
   * @param {{
   *   send: (frame: Record<string, unknown>) => void,
   *   onRequest: RequestHandler,
   *   onNote: NoteHandler,
   *   toError: (err: WireError) => unknown,
   * }} opts
   */
  constructor(opts) {
    this.#send = opts.send;
    this.#onRequest = opts.onRequest;
    this.#onNote = opts.onNote;
    this.#toError = opts.toError;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  get incomingCount() {
    return this.#incoming.size;
  }

  /**
   * Sends a request. Aborting `signal` cancels it on the other side and
   * rejects with the signal's reason.
   * @param {string} method
   * @param {unknown} params
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  request(method, params, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      /** @type {(() => void) | null} */
      let onAbort = null;
      const cleanup = () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      this.#pending.set(id, { resolve, reject, cleanup });
      if (signal) {
        onAbort = () => {
          if (!this.#pending.delete(id)) return;
          cleanup();
          try {
            this.#send({ t: "x", id });
          } catch {
            // The channel is gone; nothing to cancel.
          }
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.#send({ t: "q", id, m: method, p: params });
      } catch (err) {
        this.#pending.delete(id);
        cleanup();
        reject(err);
      }
    });
  }

  /**
   * @param {string} method
   * @param {unknown} params
   */
  notify(method, params) {
    this.#send({ t: "n", m: method, p: params });
  }

  /**
   * Handles one frame from the other side. Returns false for frames this
   * class doesn't know, so the caller can handle its own.
   * @param {any} frame
   * @returns {boolean}
   */
  handle(frame) {
    switch (frame?.t) {
      case "q":
        this.#serve(frame.id, frame.m, frame.p);
        return true;
      case "r":
      case "e": {
        const p = this.#pending.get(frame.id);
        if (!p) return true;
        this.#pending.delete(frame.id);
        p.cleanup();
        if (frame.t === "r") p.resolve(frame.v);
        else p.reject(this.#toError(frame.e ?? { name: "Error", message: "Unknown error" }));
        return true;
      }
      case "x":
        this.#incoming.get(frame.id)?.abort();
        return true;
      case "n":
        this.#onNote(frame.m, frame.p);
        return true;
      default:
        return false;
    }
  }

  /**
   * @param {unknown} id
   * @param {string} method
   * @param {unknown} params
   */
  async #serve(id, method, params) {
    if (typeof id !== "number" || this.#incoming.has(id)) return;
    const abort = new AbortController();
    this.#incoming.set(id, abort);
    /** @type {Record<string, unknown>} */
    let reply;
    try {
      reply = { t: "r", id, v: await this.#onRequest(method, params, abort.signal) };
    } catch (err) {
      reply = { t: "e", id, e: toWireError(err) };
    }
    this.#incoming.delete(id);
    if (abort.signal.aborted) return;
    try {
      this.#send(reply);
    } catch (err) {
      // The result couldn't be sent: too large, or not cloneable.
      try {
        this.#send({
          t: "e",
          id,
          e: toWireError(
            new Error(`The result couldn't be sent: ${err instanceof Error ? err.message : err}`),
          ),
        });
      } catch {
        // The channel is gone.
      }
    }
  }

  /**
   * Rejects every request this side made, and aborts every request the other
   * side made. For when the channel closes.
   * @param {unknown} error
   */
  close(error) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      p.cleanup();
      p.reject(error);
    }
    const incoming = [...this.#incoming.values()];
    this.#incoming.clear();
    for (const a of incoming) a.abort(error);
  }
}
