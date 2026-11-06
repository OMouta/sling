import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { deriveKey } from "../crypto.ts";

/**
 * Web Push's two pieces of cryptography: the VAPID key that identifies this
 * server to push services (RFC 8292), and the payload encryption that only
 * the subscribed browser can undo (RFC 8291, `aes128gcm`).
 */

export const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
export const fromB64u = (text: string): Buffer => Buffer.from(text, "base64url");

/** The order of P-256. A private scalar must be in [1, n - 1]. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface VapidKeys {
  privateKey: KeyObject;
  /** Uncompressed point, 65 bytes. */
  publicKey: Buffer;
  /** The public key as browsers take it for `applicationServerKey`. */
  publicKeyText: string;
}

/**
 * The server's VAPID key pair, derived from the master secret so there's
 * nothing new to store. A new master secret means a new key, and browsers
 * have to subscribe again.
 */
export function vapidKeys(masterSecret: string): VapidKeys {
  for (let counter = 0; ; counter++) {
    const d = deriveKey(masterSecret, counter === 0 ? "push-vapid-v1" : `push-vapid-v1:${counter}`);
    const scalar = BigInt(`0x${d.toString("hex")}`);
    // Out of range happens about once in 2^32 secrets; the next counter fixes it.
    if (scalar === 0n || scalar >= P256_ORDER) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const publicKey = ecdh.getPublicKey();
    const privateKey = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: b64u(d),
        x: b64u(publicKey.subarray(1, 33)),
        y: b64u(publicKey.subarray(33, 65)),
      },
      format: "jwk",
    });
    return { privateKey, publicKey, publicKeyText: b64u(publicKey) };
  }
}

const JWT_HEADER = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
const JWT_LIFETIME_S = 12 * 60 * 60;
/** A token is replaced this long before it expires, so one in flight never arrives stale. */
const JWT_MARGIN_S = 5 * 60;

/**
 * Signs VAPID tokens, one per push service origin, and reuses each until
 * shortly before it expires. Signing costs more than the rest of a send.
 */
export class VapidSigner {
  readonly #keys: VapidKeys;
  readonly #subject: string;
  readonly #cache = new Map<string, { header: string; until: number }>();

  constructor(keys: VapidKeys, subject: string) {
    this.#keys = keys;
    this.#subject = subject;
  }

  /** The `Authorization` header for a push to `audience`, an origin such as https://fcm.googleapis.com. */
  authorization(audience: string, now = Date.now()): string {
    const hit = this.#cache.get(audience);
    if (hit && hit.until > now) return hit.header;
    const exp = Math.floor(now / 1000) + JWT_LIFETIME_S;
    const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp, sub: this.#subject })));
    const input = `${JWT_HEADER}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), {
      key: this.#keys.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const header = `vapid t=${input}.${b64u(signature)}, k=${this.#keys.publicKeyText}`;
    this.#cache.set(audience, { header, until: (exp - JWT_MARGIN_S) * 1000 });
    return header;
  }
}

/**
 * VAPID's `sub`: how a push service's operator can reach whoever runs this
 * server. An https public URL does that; otherwise a mailto at its host.
 */
export function vapidSubject(publicUrl: URL): string {
  return publicUrl.protocol === "https:" ? publicUrl.origin : `mailto:sling@${publicUrl.hostname}`;
}

// ------------------------------------------------------------ RFC 8291

/** One record holds the whole message. Push services accept 4 KB bodies. */
const RECORD_SIZE = 4096;
const KEY_INFO = Buffer.from("WebPush: info\0");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0\x01");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0\x01");
const ONE = Buffer.from([1]);
/** Ends the last (and only) record. */
const DELIMITER = Buffer.from([2]);

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * HKDF from RFC 8291 section 3.3 and RFC 8188 section 2.2, spelled out as
 * single HMACs: every output is at most one SHA-256 block, so each expand
 * step is one HMAC over `info || 0x01`.
 */
function contentKeys(
  ecdhSecret: Buffer,
  auth: Buffer,
  uaPublic: Buffer,
  asPublic: Buffer,
  salt: Buffer,
) {
  const prkKey = hmac(auth, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([KEY_INFO, uaPublic, asPublic, ONE]));
  const prk = hmac(salt, ikm);
  return {
    cek: hmac(prk, CEK_INFO).subarray(0, 16),
    nonce: hmac(prk, NONCE_INFO).subarray(0, 12),
  };
}

export interface EncryptOptions {
  /** Fixed values, for checking against the RFC's worked example. Random otherwise. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

/**
 * Encrypts a push message for one browser subscription: `p256dh` is the
 * browser's P-256 public key and `auth` its 16-byte secret. Returns the
 * request body, header included.
 */
export function encryptPayload(
  plaintext: Buffer,
  p256dh: Buffer,
  auth: Buffer,
  opts: EncryptOptions = {},
): Buffer {
  if (plaintext.length > RECORD_SIZE - 17) throw new Error("push payload too large");
  const ecdh = createECDH("prime256v1");
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ?? randomBytes(16);
  const { cek, nonce } = contentKeys(ecdh.computeSecret(p256dh), auth, p256dh, asPublic, salt);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([
    header,
    cipher.update(plaintext),
    cipher.update(DELIMITER),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

/**
 * The browser's side of `encryptPayload`. The server never needs it; tests
 * use it to read what a push service received.
 */
export function decryptPayload(body: Buffer, uaPrivateKey: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublic = ecdh.getPublicKey();
  const { cek, nonce } = contentKeys(ecdh.computeSecret(asPublic), auth, uaPublic, asPublic, salt);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (padded[end - 1] !== 2) throw new Error("not the last record");
  return padded.subarray(0, end - 1);
}

/** True when `p256dh` is a point on P-256 and `auth` is 16 bytes, as browsers make them. */
export function validSubscriptionKeys(p256dh: Buffer, auth: Buffer): boolean {
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return false;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(p256dh);
    return true;
  } catch {
    return false;
  }
}
