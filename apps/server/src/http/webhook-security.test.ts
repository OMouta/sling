import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdmissionLimit, validWebhookSignature } from "./webhook-security.ts";

describe("webhook admission", () => {
  it("checks signed raw bytes and expires signatures", () => {
    const body = Buffer.from('{"ok":true}');
    const ts = "1794220000";
    const secret = "test-only-key";
    const signature = createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
    expect(validWebhookSignature(secret, ts, signature, body, Number(ts) * 1000)).toBe(true);
    expect(
      validWebhookSignature(secret, ts, signature, Buffer.from("changed"), Number(ts) * 1000),
    ).toBe(false);
    expect(validWebhookSignature(secret, ts, signature, body, Number(ts) * 1000 + 300001)).toBe(
      false,
    );
    expect(validWebhookSignature(secret, ts, "x", body)).toBe(false);
  });
  it("limits each key and recovers after the window", () => {
    const limiter = new AdmissionLimit();
    expect(limiter.take("a", 1, 0)).toBe(true);
    expect(limiter.take("a", 1, 1)).toBe(false);
    expect(limiter.take("b", 1, 1)).toBe(true);
    expect(limiter.take("a", 1, 60_001)).toBe(true);
  });
});
