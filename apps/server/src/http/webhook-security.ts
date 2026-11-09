import { createHmac, timingSafeEqual } from "node:crypto";

export function validWebhookSignature(
  secret: string,
  timestamp: string,
  signature: string,
  body: Buffer,
  now = Date.now(),
): boolean {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** Fixed-window admission limiter. Keys expire and cardinality is bounded. */
export class AdmissionLimit {
  readonly buckets = new Map<string, { until: number; used: number }>();
  take(key: string, limit: number, now = Date.now()): boolean {
    for (const [id, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) return false;
      bucket = { until: now + 60_000, used: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.used >= limit) return false;
    bucket.used++;
    return true;
  }
}
