import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type Envelope, EnvelopeSchema } from "../gen/sling/runner/v1/runner_pb.js";

export * from "../gen/sling/runner/v1/runner_pb.js";
export { create };

/** WebSocket path the Runner connects to. */
export const RUNNER_WS_PATH = "/runner/v1/ws";

/** How far a Hello timestamp may drift from the server clock. */
export const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Bytes the Runner signs in Hello. Keep in sync with the Rust implementation in
 * crates/runner-protocol.
 */
export function authPayload(nonce: Uint8Array, runnerId: string, timestampMs: bigint): Uint8Array {
  const hex = Buffer.from(nonce).toString("hex");
  return new TextEncoder().encode(`sling-runner-auth-v1\n${hex}\n${runnerId}\n${timestampMs}`);
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  return toBinary(EnvelopeSchema, envelope);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  return fromBinary(EnvelopeSchema, bytes);
}
