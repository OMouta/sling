import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  b64u,
  decryptPayload,
  encryptPayload,
  fromB64u,
  VapidSigner,
  validSubscriptionKeys,
  vapidKeys,
  vapidSubject,
} from "./crypto.ts";

/** RFC 8291 section 5 and Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 aes128gcm", () => {
  it("encrypts the worked example byte for byte", () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      fromB64u(RFC.uaPublic),
      fromB64u(RFC.auth),
      { salt: fromB64u(RFC.salt), senderPrivateKey: fromB64u(RFC.asPrivate) },
    );
    expect(b64u(body)).toBe(RFC.body);
    expect(body.length).toBe(144);
  });

  it("decrypts the worked example with the receiver's key", () => {
    const out = decryptPayload(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.auth));
    expect(out.toString()).toBe(RFC.plaintext);
  });

  it("uses a fresh key and salt for every message", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const a = encryptPayload(Buffer.from("hi"), ua.getPublicKey(), auth);
    const b = encryptPayload(Buffer.from("hi"), ua.getPublicKey(), auth);
    expect(a.subarray(0, 86).equals(b.subarray(0, 86))).toBe(false);
    expect(decryptPayload(a, ua.getPrivateKey(), auth).toString()).toBe("hi");
  });

  it("fails to decrypt with the wrong auth secret", () => {
    expect(() =>
      decryptPayload(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), Buffer.alloc(16)),
    ).toThrow();
  });

  it("checks a subscription's keys", () => {
    expect(validSubscriptionKeys(fromB64u(RFC.uaPublic), fromB64u(RFC.auth))).toBe(true);
    const offCurve = fromB64u(RFC.uaPublic);
    offCurve[40] = (offCurve[40] ?? 0) ^ 1;
    expect(validSubscriptionKeys(offCurve, fromB64u(RFC.auth))).toBe(false);
    expect(validSubscriptionKeys(fromB64u(RFC.uaPublic), Buffer.alloc(8))).toBe(false);
    expect(validSubscriptionKeys(Buffer.alloc(65, 4), fromB64u(RFC.auth))).toBe(false);
  });
});

describe("VAPID", () => {
  const secret = "push-test-secret-that-is-long-enough-to-use";
  const keys = vapidKeys(secret);

  it("derives the same P-256 key from the same secret", () => {
    expect(vapidKeys(secret).publicKeyText).toBe(keys.publicKeyText);
    expect(vapidKeys(`${secret}!`).publicKeyText).not.toBe(keys.publicKeyText);
    expect(keys.publicKey.length).toBe(65);
    expect(keys.publicKey[0]).toBe(4);
  });

  it("signs an ES256 token that verifies with the public key", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const header = new VapidSigner(keys, "https://sling.example.com").authorization(
      "https://fcm.googleapis.com",
      now,
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m?.[2]).toBe(keys.publicKeyText);
    const token = m?.[1] ?? "";
    const [h, c, s] = token.split(".") as [string, string, string];
    expect(JSON.parse(fromB64u(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64u(c).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "https://sling.example.com",
    });
    const pub = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64u(keys.publicKey.subarray(1, 33)),
        y: b64u(keys.publicKey.subarray(33)),
      },
      format: "jwk",
    });
    const sig = fromB64u(s);
    expect(sig.length).toBe(64);
    expect(
      verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, sig),
    ).toBe(true);
  });

  it("reuses a token per audience until five minutes before it expires", () => {
    const signer = new VapidSigner(keys, "mailto:sling@localhost");
    const t0 = Date.UTC(2026, 10, 6, 12);
    const first = signer.authorization("https://web.push.apple.com", t0);
    expect(signer.authorization("https://web.push.apple.com", t0 + 11 * 3600_000)).toBe(first);
    expect(signer.authorization("https://fcm.googleapis.com", t0)).not.toBe(first);
    const later = signer.authorization("https://web.push.apple.com", t0 + (12 * 60 - 4) * 60_000);
    expect(later).not.toBe(first);
  });

  it("names an https public URL, else a mailto", () => {
    expect(vapidSubject(new URL("https://sling.example.com/x"))).toBe("https://sling.example.com");
    expect(vapidSubject(new URL("http://localhost:8080"))).toBe("mailto:sling@localhost");
  });
});
