/**
 * `WebSocket` for extension code. The server opens the real socket after
 * checking it against the extension's permissions and relays messages both
 * ways. Follows the browser API: open, message, error, and close events, the
 * on* handler properties, text and binary messages, and `binaryType`.
 */

/** Messages are capped at this size in both directions. */
export const MAX_SOCKET_MESSAGE_BYTES = 1024 * 1024;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const enc = new TextEncoder();

/**
 * @typedef {{
 *   request(method: string, params: unknown, signal?: AbortSignal): Promise<any>,
 *   notify(method: string, params: unknown): void,
 * }} SocketPeer
 * @typedef {{
 *   message(data: string | Uint8Array): void,
 *   closed(code: number, reason: string, wasClean: boolean): void,
 *   error(message: string): void,
 * }} SocketEvents
 */

/**
 * Builds the WebSocket class and the handler the runtime calls with the
 * server's socket notifications.
 * @param {SocketPeer} peer
 */
export function makeWebSocket(peer) {
  /** @type {Map<number, SocketEvents>} */
  const live = new Map();
  let nextId = 1;

  class WebSocket extends EventTarget {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    #id = nextId++;
    #url;
    #readyState = CONNECTING;
    #protocol = "";
    #extensions = "";
    /** @type {"blob" | "arraybuffer"} */
    #binaryType = "blob";
    #bufferedAmount = 0;
    #opening = new AbortController();
    /** Sends wait for Blobs to be read, so messages keep their order. */
    #queue = Promise.resolve();
    /** @type {Record<string, ((ev: Event) => void) | null>} */
    #handlers = { open: null, message: null, error: null, close: null };
    /**
     * Events the server relayed before its answer to the open request
     * arrived. The server sends them in order, so they replay after "open".
     * @type {(() => void)[]}
     */
    #early = [];

    /**
     * @param {string | URL} url
     * @param {string | string[]} [protocols]
     */
    constructor(url, protocols = []) {
      super();
      let u;
      try {
        u = new URL(String(url));
      } catch {
        throw new DOMException(`Invalid URL: ${String(url)}`, "SyntaxError");
      }
      if (u.protocol === "http:") u.protocol = "ws:";
      else if (u.protocol === "https:") u.protocol = "wss:";
      if (u.protocol !== "ws:" && u.protocol !== "wss:") {
        throw new DOMException(`Unsupported scheme ${u.protocol} in ${u.href}`, "SyntaxError");
      }
      if (u.hash) throw new DOMException("A WebSocket URL can't have a fragment", "SyntaxError");
      const list = typeof protocols === "string" ? [protocols] : [...protocols];
      if (new Set(list).size !== list.length) {
        throw new DOMException("Duplicate subprotocols", "SyntaxError");
      }
      this.#url = u.href;
      /** @param {() => void} fn */
      const deliver = (fn) => {
        if (this.#readyState === CONNECTING) this.#early.push(fn);
        else fn();
      };
      live.set(this.#id, {
        message: (data) => deliver(() => this.#onMessage(data)),
        closed: (code, reason, wasClean) => deliver(() => this.#onClosed(code, reason, wasClean)),
        error: (message) => deliver(() => this.#onError(message)),
      });
      peer
        .request("ws.open", { id: this.#id, url: u.href, protocols: list }, this.#opening.signal)
        .then(
          (r) => {
            if (this.#readyState !== CONNECTING) return;
            this.#readyState = OPEN;
            this.#protocol = String(r?.protocol ?? "");
            this.#extensions = String(r?.extensions ?? "");
            this.dispatchEvent(new Event("open"));
            const early = this.#early;
            this.#early = [];
            for (const fn of early) fn();
          },
          (err) => {
            this.#early = [];
            if (this.#readyState === CLOSED) return;
            this.#onError(err instanceof Error ? err.message : String(err));
            this.#onClosed(1006, "", false);
          },
        );
    }

    get url() {
      return this.#url;
    }
    get readyState() {
      return this.#readyState;
    }
    get protocol() {
      return this.#protocol;
    }
    get extensions() {
      return this.#extensions;
    }
    get bufferedAmount() {
      return this.#bufferedAmount;
    }
    get binaryType() {
      return this.#binaryType;
    }
    set binaryType(v) {
      if (v === "blob" || v === "arraybuffer") this.#binaryType = v;
    }

    get onopen() {
      return this.#handlers.open ?? null;
    }
    set onopen(fn) {
      this.#setHandler("open", fn);
    }
    get onmessage() {
      return this.#handlers.message ?? null;
    }
    set onmessage(fn) {
      this.#setHandler("message", fn);
    }
    get onerror() {
      return this.#handlers.error ?? null;
    }
    set onerror(fn) {
      this.#setHandler("error", fn);
    }
    get onclose() {
      return this.#handlers.close ?? null;
    }
    set onclose(fn) {
      this.#setHandler("close", fn);
    }

    /**
     * @param {string} type
     * @param {unknown} fn
     */
    #setHandler(type, fn) {
      const old = this.#handlers[type];
      if (old) this.removeEventListener(type, old);
      const next = typeof fn === "function" ? /** @type {(ev: Event) => void} */ (fn) : null;
      this.#handlers[type] = next;
      if (next) this.addEventListener(type, next);
    }

    /** @param {string | ArrayBufferLike | ArrayBufferView | Blob} data */
    send(data) {
      if (this.#readyState === CONNECTING) {
        throw new DOMException("The socket is still connecting", "InvalidStateError");
      }
      /** @type {string | Uint8Array | Promise<Uint8Array>} */
      let payload;
      let size;
      if (typeof data === "string") {
        payload = data;
        size = enc.encode(data).byteLength;
      } else if (data instanceof Blob) {
        payload = data.arrayBuffer().then((b) => new Uint8Array(b));
        size = data.size;
      } else if (ArrayBuffer.isView(data)) {
        payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        size = data.byteLength;
      } else if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
        payload = new Uint8Array(data).slice();
        size = data.byteLength;
      } else {
        payload = String(data);
        size = enc.encode(payload).byteLength;
      }
      if (this.#readyState !== OPEN) {
        this.#bufferedAmount += size;
        return;
      }
      if (size > MAX_SOCKET_MESSAGE_BYTES) {
        this.#onError("Sling refused to send the message: it's over 1 MB");
        this.close(1009);
        return;
      }
      this.#bufferedAmount += size;
      const id = this.#id;
      this.#queue = this.#queue.then(async () => {
        const body = await payload;
        this.#bufferedAmount -= size;
        if (this.#readyState === OPEN || this.#readyState === CLOSING) {
          peer.notify("ws.send", { id, data: body });
        }
      });
    }

    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code, reason) {
      if (code !== undefined && code !== 1000 && code !== 1009 && (code < 3000 || code > 4999)) {
        throw new DOMException(`Invalid close code ${code}`, "InvalidAccessError");
      }
      if (reason !== undefined && enc.encode(reason).byteLength > 123) {
        throw new DOMException("The close reason is over 123 bytes", "SyntaxError");
      }
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      if (this.#readyState === CONNECTING) {
        this.#readyState = CLOSING;
        this.#opening.abort();
        this.#onError("The socket was closed before it connected");
        this.#onClosed(1006, "", false);
        return;
      }
      this.#readyState = CLOSING;
      const id = this.#id;
      this.#queue = this.#queue.then(() => {
        peer.notify("ws.close", { id, code, reason });
      });
    }

    /** @param {string | Uint8Array} data */
    #onMessage(data) {
      if (this.#readyState !== OPEN) return;
      /** @type {string | ArrayBuffer | Blob} */
      let out;
      if (typeof data === "string") out = data;
      else {
        const ab = new Uint8Array(data).buffer;
        out = this.#binaryType === "arraybuffer" ? ab : new Blob([ab]);
      }
      this.dispatchEvent(
        new MessageEvent("message", { data: out, origin: new URL(this.#url).origin }),
      );
    }

    /** @param {string} message */
    #onError(message) {
      this.dispatchEvent(new ErrorEvent("error", { message, error: new TypeError(message) }));
    }

    /**
     * @param {number} code
     * @param {string} reason
     * @param {boolean} wasClean
     */
    #onClosed(code, reason, wasClean) {
      if (this.#readyState === CLOSED) return;
      this.#readyState = CLOSED;
      live.delete(this.#id);
      this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
    }
  }

  for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    Object.defineProperty(WebSocket.prototype, k, { value: v, enumerable: true });
  }

  /**
   * Routes the server's socket notifications to the right socket.
   * @param {string} method
   * @param {any} p
   * @returns {boolean} whether the note was a socket note
   */
  function onNote(method, p) {
    const s = live.get(p?.id);
    switch (method) {
      case "ws.message":
        s?.message(p.data);
        return true;
      case "ws.closed":
        s?.closed(Number(p.code ?? 1006), String(p.reason ?? ""), Boolean(p.wasClean));
        return true;
      case "ws.error":
        s?.error(String(p.message ?? "The socket failed"));
        return true;
      default:
        return false;
    }
  }

  return { WebSocket, onNote };
}
