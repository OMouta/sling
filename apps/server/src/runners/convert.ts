import type { PermissionMode } from "@sling/core";
import { PermissionMode as ProtoMode } from "@sling/runner-protocol";

const TO_PROTO: Record<PermissionMode, ProtoMode> = {
  "read-only": ProtoMode.READ_ONLY,
  supervised: ProtoMode.SUPERVISED,
  auto: ProtoMode.AUTO,
  "full-access": ProtoMode.FULL_ACCESS,
};

export function modeToProto(mode: PermissionMode): ProtoMode {
  return TO_PROTO[mode];
}

/** Unknown or unset values map to the most restrictive mode. */
export function modeFromProto(mode: ProtoMode): PermissionMode {
  switch (mode) {
    case ProtoMode.FULL_ACCESS:
      return "full-access";
    case ProtoMode.AUTO:
      return "auto";
    case ProtoMode.SUPERVISED:
      return "supervised";
    default:
      return "read-only";
  }
}
