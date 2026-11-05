import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  normalizePairingCode,
  pairingCode,
} from "./crypto.ts";

describe("secret encryption", () => {
  const key = deriveKey("x".repeat(48), "test");

  it("round-trips and never stores plaintext", () => {
    const sealed = encryptSecret(key, "sk-live-123");
    expect(sealed).not.toContain("sk-live-123");
    expect(decryptSecret(key, sealed)).toBe("sk-live-123");
  });

  it("fails with the wrong key", () => {
    const sealed = encryptSecret(key, "secret");
    expect(() => decryptSecret(deriveKey("y".repeat(48), "test"), sealed)).toThrow();
  });

  it("derives different keys per purpose", () => {
    expect(deriveKey("m".repeat(40), "a").equals(deriveKey("m".repeat(40), "b"))).toBe(false);
  });
});

describe("pairing codes", () => {
  it("are grouped and normalize", () => {
    const code = pairingCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(normalizePairingCode(code.toLowerCase())).toBe(code.replaceAll("-", ""));
  });
});
