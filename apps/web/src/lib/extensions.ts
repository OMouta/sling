import type {
  DiscoverEntryView,
  ExtensionContents,
  ExtensionKind,
  ExtensionStatus,
  PermissionLine,
} from "@sling/core";
import type { Tone } from "../components/ui.tsx";
import { plural } from "./format.ts";

/** How each status reads on a card. `stopped` only means no process is running yet. */
export const EXTENSION_STATUS: Record<
  ExtensionStatus,
  { tone: Tone; label: string; hint: string }
> = {
  running: { tone: "ok", label: "running", hint: "Its process is running." },
  starting: { tone: "warn", label: "starting", hint: "Its process is starting." },
  stopped: { tone: "neutral", label: "idle", hint: "Its process starts the next time it's used." },
  error: {
    tone: "danger",
    label: "error",
    hint: "It kept crashing, so it's stopped. Turn it off and on to try again.",
  },
  disabled: {
    tone: "neutral",
    label: "disabled",
    hint: "Turned off. Its nodes fail until you turn it on.",
  },
  unsupported: { tone: "warn", label: "unsupported", hint: "This server can't run its code." },
};

export const KIND_LABEL: Record<ExtensionKind, string> = {
  connector: "Connectors",
  provider: "Sandbox providers",
  workflows: "Workflow packages",
};

/** A workflow package adds templates and runs no code, so it has no process. */
export function runsCode(contents: ExtensionContents): boolean {
  return contents.connectors.length > 0 || contents.nodes.length > 0;
}

/** "820 B", "48 KB", "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "2 actions and 1 trigger". */
export function nodeSummary(nodes: ExtensionContents["nodes"]): string {
  const triggers = nodes.filter((n) => n.isTrigger).length;
  const actions = nodes.length - triggers;
  const parts = [
    actions > 0 && plural(actions, "action"),
    triggers > 0 && plural(triggers, "trigger"),
  ].filter(Boolean);
  return parts.join(" and ");
}

/** One short line for a card: the riskiest permission, and how many more. */
export function permissionSummary(lines: PermissionLine[]): { text: string; more: number } {
  const first = lines.find((l) => l.risk === "high") ?? lines[0];
  if (!first) return { text: "Needs no permissions", more: 0 };
  return { text: first.text, more: lines.length - 1 };
}

export function hasHighRisk(lines: PermissionLine[]): boolean {
  return lines.some((l) => l.risk === "high");
}

/** Discover entries matching a search and a kind, by name, ID, description, or publisher. */
export function filterDiscover(
  entries: DiscoverEntryView[],
  query: string,
  kind: ExtensionKind | "all",
): DiscoverEntryView[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (kind !== "all" && !e.kinds.includes(kind)) return false;
    const hay = [e.name, e.id, e.description, e.publisher?.name ?? "", e.catalogName]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Extension IDs: 3 to 40 lowercase letters, digits, and hyphens, starting with a letter. */
export const EXTENSION_ID = /^[a-z][a-z0-9-]{2,39}$/;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A package ID from a workflow's name: "Notify on deploy!" becomes "notify-on-deploy". */
export function suggestPackageId(name: string): string {
  let slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  // Cut long names between words.
  if (slug.length > 40) {
    const cut = slug.slice(0, 41);
    slug = cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut.slice(0, 40);
  }
  return slug.length >= 3 ? slug : `${slug ? `${slug}-` : ""}workflow`;
}
