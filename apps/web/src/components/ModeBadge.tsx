import { MODE_POLICY, type PermissionMode } from "@sling/core";
import { Badge } from "./ui.tsx";

const TONE = {
  "read-only": "neutral",
  supervised: "accent",
  auto: "ok",
  "full-access": "danger",
} as const;

export function ModeBadge({ mode }: { mode: PermissionMode }) {
  return <Badge tone={TONE[mode]}>{MODE_POLICY[mode].label}</Badge>;
}
