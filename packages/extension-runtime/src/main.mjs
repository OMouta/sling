/**
 * Entry point of an extension's process. The server starts it under Node's
 * permission model with read access to this directory and the extension's
 * package, and nothing else: no writes, network, child processes, workers,
 * addons, or environment.
 *
 *   node --permission ... main.mjs <bundle path> <extension id>
 *
 * Messages go over stdin and stdout (see frames.mjs). Everything the
 * extension prints is sent to the server as log lines instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { format, inspect } from "node:util";
import { createDispatcher } from "./dispatch.mjs";
import { makeFetch } from "./fetch.mjs";
import { encodeFrame, FrameDecoder } from "./frames.mjs";
import { Peer, toWireError } from "./peer.mjs";
import { makeWebSocket } from "./websocket.mjs";

const [bundlePath, extensionId] = process.argv.slice(2);

// The server starts this process with an empty environment, but the OS can
// still add variables of its own (macOS adds __CF_USER_TEXT_ENCODING).
for (const key of Object.keys(process.env)) delete process.env[key];

const out = process.stdout;
const writeOut = out.write.bind(out);

/** @param {Record<string, unknown>} frame */
function send(frame) {
  writeOut(encodeFrame(frame));
}

const MAX_LOG_CHARS = 8000;

/** Which call a console line belongs to, so it reaches that run's log. */
const scopes = new AsyncLocalStorage();

/**
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 * @param {unknown} [data]
 * @param {unknown} [scope]
 */
function log(level, message, data, scope = scopes.getStore()) {
  const text = message.length > MAX_LOG_CHARS ? `${message.slice(0, MAX_LOG_CHARS)}…` : message;
  try {
    send({ t: "n", m: "log", p: { level, message: text, data, scope } });
  } catch {
    // Data that can't be cloned, or is too large: send it as text.
    try {
      const shown = inspect(data, { depth: 4, breakLength: Infinity }).slice(0, MAX_LOG_CHARS);
      send({ t: "n", m: "log", p: { level, message: text, data: { data: shown }, scope } });
    } catch {
      // The channel is gone.
    }
  }
}

/** @param {"info" | "warn" | "error"} level */
function logStream(level) {
  return new Writable({
    decodeStrings: false,
    write(chunk, _enc, cb) {
      log(level, String(chunk).replace(/\n$/, ""));
      cb();
    },
  });
}

const console = new Console({ stdout: logStream("info"), stderr: logStream("error") });
console.warn = (...args) => log("warn", format(...args));
globalThis.console = console;
// Direct writes to stdout would corrupt the message stream.
out.write = /** @type {typeof out.write} */ (
  (/** @type {unknown} */ chunk, /** @type {unknown[]} */ ...rest) => {
    log("info", String(chunk).replace(/\n$/, ""));
    const cb = rest.find((a) => typeof a === "function");
    if (cb) queueMicrotask(/** @type {() => void} */ (cb));
    return true;
  }
);

/** Permission names by the flag that would grant them. */
const FLAG_PERMISSIONS = /** @type {Record<string, string>} */ ({
  "fs-read": "FileSystemRead",
  "fs-write": "FileSystemWrite",
  net: "Net",
  "child-process": "ChildProcess",
  worker: "WorkerThreads",
  wasi: "WASI",
  addons: "Addons",
  inspector: "Inspector",
});

/**
 * Says what the permission model or the code-generation flag refused, for
 * the extension's log. Null for any other error.
 * @param {unknown} err
 */
function describeRefusal(err) {
  const e = /** @type {any} */ (err);
  if (e?.code === "ERR_ACCESS_DENIED") {
    // Socket and DNS errors from libuv don't say which permission: the message
    // names its flag, or the syscall is a name lookup.
    const flag = /--allow-([a-z-]+)/.exec(String(e.message))?.[1];
    const lookup = /^(getaddrinfo|getnameinfo|query)/.test(String(e.syscall ?? ""));
    const permission = e.permission ?? (flag ? FLAG_PERMISSIONS[flag] : lookup ? "Net" : undefined);
    const resource = e.resource || e.hostname;
    const what = permission ? `${permission} access` : "access";
    return `Sling refused ${what}${resource ? ` to ${resource}` : ""}: ${e.message}`;
  }
  if (e?.name === "EvalError" && /code generation/i.test(String(e.message))) {
    return `Sling refused code generation from strings: ${e.message}`;
  }
  if (e?.code === "ERR_DLOPEN_DISABLED")
    return `Sling refused to load a native addon: ${e.message}`;
  return null;
}

/** @param {import("./peer.mjs").WireError} e */
function toError(e) {
  const err = e.name === "TypeError" ? new TypeError(e.message) : new Error(e.message);
  if (e.name !== "TypeError") err.name = e.name;
  if (e.code) /** @type {any} */ (err).code = e.code;
  return err;
}

/** @type {((method: string, params: any, signal: AbortSignal) => Promise<unknown>) | null} */
let dispatch = null;
/** @type {(method: string, params: any) => boolean} */
let onSocketNote = () => false;

const peer = new Peer({
  send,
  toError,
  onRequest: async (method, params, signal) => {
    if (!dispatch) throw new Error("The extension hasn't loaded");
    const run = /** @type {NonNullable<typeof dispatch>} */ (dispatch);
    const scope = params?.scope ?? (params?.sid !== undefined ? `source:${params.sid}` : null);
    try {
      return await scopes.run(scope, () => run(method, params, signal));
    } catch (err) {
      const refusal = describeRefusal(err);
      if (refusal) log("error", refusal, undefined, scope);
      throw err;
    }
  },
  onNote: (method, params) => {
    onSocketNote(method, params);
  },
});

const decoder = new FrameDecoder();
process.stdin.on("data", (/** @type {Buffer} */ chunk) => {
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch (err) {
    process.stderr.write(`Sling's channel failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(70);
  }
  for (const frame of frames) {
    const f = /** @type {any} */ (frame);
    if (f?.t === "ping") {
      send({ t: "pong" });
      continue;
    }
    peer.handle(f);
  }
});
// The server closed the channel or exited: nothing more will come.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

process.on("uncaughtExceptionMonitor", (err) => {
  const refusal = describeRefusal(err);
  if (refusal) process.stderr.write(`${refusal}\n`);
});

const nativeFetch = globalThis.fetch;
globalThis.fetch = makeFetch(peer, nativeFetch);
const sockets = makeWebSocket(peer);
onSocketNote = sockets.onNote;
globalThis.WebSocket = /** @type {any} */ (sockets.WebSocket);

try {
  if (!bundlePath || !extensionId) throw new Error("Usage: main.mjs <bundle path> <extension id>");
  const mod = await import(pathToFileURL(bundlePath).href);
  const def = mod.default;
  if (!def || !Array.isArray(def.connectors) || typeof def.describe !== "function") {
    throw new Error("The bundle's default export isn't defineExtension(...)");
  }
  dispatch = createDispatcher(def, extensionId, peer, log);
  send({ t: "ready" });
} catch (err) {
  const refusal = describeRefusal(err);
  if (refusal) process.stderr.write(`${refusal}\n`);
  writeOut(encodeFrame({ t: "fatal", e: toWireError(err) }), () => process.exit(1));
}
