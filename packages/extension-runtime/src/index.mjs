/**
 * The server's side of the package: where the child runtime lives, and the
 * framing and request code both sides share.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory extension processes may read, besides their own package. */
export const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
/** The child's entry point. */
export const MAIN_PATH = fileURLToPath(new URL("./main.mjs", import.meta.url));

export { MAX_BODY_BYTES } from "./fetch.mjs";
export { encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES } from "./frames.mjs";
export { Peer, toWireError } from "./peer.mjs";
export { MAX_SOCKET_MESSAGE_BYTES } from "./websocket.mjs";
