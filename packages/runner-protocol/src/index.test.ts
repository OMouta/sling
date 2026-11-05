import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtures } from "./fixtures.ts";
import { authPayload, decodeEnvelope, encodeEnvelope } from "./index.ts";

describe("runner protocol", () => {
  it("round-trips every fixture", () => {
    for (const envelope of Object.values(fixtures)) {
      expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("matches the committed fixture bytes", () => {
    for (const [name, envelope] of Object.entries(fixtures)) {
      const committed = readFileSync(new URL(`../fixtures/${name}.bin`, import.meta.url));
      expect(Buffer.from(encodeEnvelope(envelope)).equals(committed)).toBe(true);
    }
  });

  it("builds the auth payload in the documented format", () => {
    const payload = authPayload(new Uint8Array([0xab, 0x01]), "rnr_01", 1234n);
    expect(new TextDecoder().decode(payload)).toBe("sling-runner-auth-v1\nab01\nrnr_01\n1234");
  });
});
