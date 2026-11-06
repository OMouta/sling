/**
 * Framing for the channel between the server and an extension's process:
 * each message is a 4-byte big-endian length followed by the message in V8's
 * structured-clone format. The length comes first so a receiver can refuse an
 * oversized message before buffering it.
 */
import { DefaultDeserializer, DefaultSerializer } from "node:v8";

/** The largest message either side accepts, in bytes. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER = Buffer.alloc(4);

export class FrameError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
}

/**
 * Serializes one message with its length header in a single buffer.
 * Throws a FrameError when it's over the limit, and a DataCloneError when
 * the value can't be cloned.
 * @param {unknown} message
 * @param {number} [maxBytes]
 * @returns {Buffer}
 */
export function encodeFrame(message, maxBytes = MAX_FRAME_BYTES) {
  const ser = new DefaultSerializer();
  ser.writeRawBytes(HEADER);
  ser.writeHeader();
  ser.writeValue(message);
  const buf = ser.releaseBuffer();
  const size = buf.length - 4;
  if (size > maxBytes) {
    throw new FrameError(`The message is ${mb(size)}, over the ${mb(maxBytes)} limit`);
  }
  buf.writeUInt32BE(size, 0);
  return buf;
}

/** @param {number} n */
function mb(n) {
  return `${Math.ceil(n / (1024 * 1024))} MB`;
}

/** @param {Uint8Array} bytes */
function decodeOne(bytes) {
  const des = new DefaultDeserializer(bytes);
  des.readHeader();
  return des.readValue();
}

/** Splits a byte stream back into messages. */
export class FrameDecoder {
  /** @type {Buffer[]} */
  #chunks = [];
  #size = 0;
  /** Length of the message being read, or -1 before its header arrives. */
  #need = -1;
  #max;

  /** @param {number} [maxBytes] */
  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.#max = maxBytes;
  }

  /**
   * Adds bytes and returns every message they complete. Throws a FrameError
   * as soon as a header announces a message over the limit.
   * @param {Buffer} chunk
   * @returns {unknown[]}
   */
  push(chunk) {
    /** @type {unknown[]} */
    const out = [];
    if (chunk.length === 0) return out;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    for (;;) {
      if (this.#need < 0) {
        if (this.#size < 4) break;
        const head = this.#take(4);
        this.#need = head.readUInt32BE(0);
        if (this.#need > this.#max) {
          throw new FrameError(`A message of ${mb(this.#need)} is over the ${mb(this.#max)} limit`);
        }
      }
      if (this.#size < this.#need) break;
      const body = this.#take(this.#need);
      this.#need = -1;
      out.push(decodeOne(body));
    }
    return out;
  }

  /** Removes and returns the first n buffered bytes, copying only when they span chunks. */
  #take(/** @type {number} */ n) {
    const first = /** @type {Buffer} */ (this.#chunks[0]);
    let out;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
    } else {
      out = Buffer.allocUnsafe(n);
      let at = 0;
      let used = 0;
      while (at < n) {
        const c = /** @type {Buffer} */ (this.#chunks[used]);
        const k = Math.min(c.length, n - at);
        c.copy(out, at, 0, k);
        at += k;
        if (k === c.length) used++;
        else this.#chunks[used] = c.subarray(k);
      }
      // One splice, not a shift per chunk: a message can span many small reads.
      this.#chunks.splice(0, used);
    }
    this.#size -= n;
    return out;
  }
}
