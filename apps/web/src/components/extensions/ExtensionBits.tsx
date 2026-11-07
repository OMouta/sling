import type {
  ExtensionContents,
  ExtensionKind,
  ExtensionView,
  PermissionLine,
  PublisherRef,
} from "@sling/core";
import {
  BadgeCheck,
  BookOpen,
  Box,
  Globe,
  LayoutTemplate,
  type LucideIcon,
  Network,
  Plug,
  Puzzle,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { extensionIconUrl } from "../../lib/extensionApi.ts";
import { EXTENSION_STATUS, nodeSummary } from "../../lib/extensions.ts";
import { plural } from "../../lib/format.ts";
import { Badge, cx, Dot } from "../ui.tsx";

const TILE = {
  sm: "size-8 rounded-lg",
  md: "size-9 rounded-lg",
  lg: "size-10 rounded-lg",
};
const IMAGE = { sm: "size-4", md: "size-5", lg: "size-6" };

/** The generic icon for what a package adds, when it ships none of its own. */
export function kindIcon(kinds: ExtensionKind[]): LucideIcon {
  if (kinds.includes("provider")) return Box;
  if (kinds.includes("connector")) return Plug;
  if (kinds.includes("workflows")) return LayoutTemplate;
  return Puzzle;
}

/**
 * An extension's own icon on a raised tile, or a generic one. The image is
 * loaded with `<img>`, so an SVG can't run scripts.
 */
export function ExtensionIcon({
  ext,
  fallback: Fallback = Puzzle,
  size = "md",
  flat,
}: {
  ext?: { id: string; version: string; hasIcon: boolean } | null;
  fallback?: LucideIcon;
  size?: "sm" | "md" | "lg";
  /** On a raised surface already, as in a list of buttons. */
  flat?: boolean;
}) {
  const src = ext?.hasIcon ? extensionIconUrl(ext) : null;
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span
      className={cx(
        "grid shrink-0 place-items-center overflow-hidden text-icon",
        flat ? "bg-surface-3" : "bg-surface-2 shadow-raised",
        TILE[size],
      )}
    >
      {src && broken !== src ? (
        <img
          src={src}
          alt=""
          className={cx("object-contain", IMAGE[size])}
          onError={() => setBroken(src)}
        />
      ) : (
        <Fallback aria-hidden="true" size={size === "sm" ? 14 : 16} />
      )}
    </span>
  );
}

/**
 * Who stands behind a package: the publisher with a trusted mark, "Included
 * with Sling", or "Unsigned".
 */
export function PublisherLabel({
  publisher,
  included,
  signed,
}: {
  publisher: PublisherRef | null;
  included: boolean;
  signed: boolean;
}) {
  if (included) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted">
        <BadgeCheck aria-hidden="true" size={13} className="shrink-0 text-accent-text" />
        <span className="truncate">Included with Sling</span>
      </span>
    );
  }
  if (!signed || !publisher) {
    return (
      <Badge tone="warn" className="h-5 px-1.5">
        Unsigned
      </Badge>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-xs text-muted"
      title={`Key ${publisher.fingerprint}`}
    >
      <span className="truncate">{publisher.name}</span>
      {publisher.trusted ? (
        <>
          <BadgeCheck aria-hidden="true" size={13} className="shrink-0 text-accent-text" />
          <span className="sr-only">(trusted)</span>
        </>
      ) : (
        <span className="shrink-0 text-subtle">· not trusted yet</span>
      )}
    </span>
  );
}

export function StatusLabel({ ext }: { ext: Pick<ExtensionView, "status" | "contents"> }) {
  const s = EXTENSION_STATUS[ext.status];
  // Running, idle and starting are the process's business. Only what needs you shows.
  if (ext.status !== "error" && ext.status !== "unsupported") return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-soft" title={s.hint}>
      <Dot tone={s.tone} />
      {s.label}
    </span>
  );
}

/** What a package adds: its connectors and providers, nodes, and templates. */
export function Adds({ contents, className }: { contents: ExtensionContents; className?: string }) {
  const items: { icon: LucideIcon; text: string; key: string }[] = [
    ...contents.connectors.map((c) => ({
      key: `c:${c.id}`,
      icon: c.isExecutionProvider ? Box : Plug,
      text: c.isExecutionProvider ? `${c.name} sandbox provider` : `${c.name} connector`,
    })),
    ...(contents.nodes.length > 0
      ? [{ key: "nodes", icon: Workflow, text: nodeSummary(contents.nodes) }]
      : []),
    ...(contents.templates.length === 1
      ? [{ key: "tpl", icon: LayoutTemplate, text: `${contents.templates[0]?.name} template` }]
      : contents.templates.length > 1
        ? [
            {
              key: "tpl",
              icon: LayoutTemplate,
              text: plural(contents.templates.length, "template"),
            },
          ]
        : []),
  ];
  if (items.length === 0) return null;
  return (
    <ul aria-label="Adds" className={cx("flex flex-wrap gap-x-3 gap-y-1", className)}>
      {items.map(({ key, icon: Icon, text }) => (
        <li key={key} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <Icon aria-hidden="true" size={12} className="shrink-0 text-subtle" />
          <span className="truncate">{text}</span>
        </li>
      ))}
    </ul>
  );
}

function permissionIcon(key: string): LucideIcon {
  if (key.startsWith("host:") || key.startsWith("configHost:")) return Globe;
  if (key === "localNetwork") return Network;
  if (key === "approvals") return ShieldCheck;
  if (key === "sandboxes") return Box;
  return Shield;
}

/** Permission lines as the server words them, with high-risk ones marked. */
export function PermissionList({
  lines,
  mark,
  label = "Permissions",
}: {
  lines: PermissionLine[];
  /** "+" or "−" before each line, for an update's diff. */
  mark?: "added" | "removed";
  label?: string;
}) {
  return (
    <ul aria-label={label} className="space-y-2">
      {lines.map((l) => {
        const high = l.risk === "high";
        const Icon = high ? ShieldAlert : permissionIcon(l.key);
        return (
          <li key={l.key} className="flex items-start gap-2.5 text-[13px] leading-5">
            <Icon
              aria-hidden="true"
              size={14}
              className={cx("mt-[3px] shrink-0", high ? "text-warn" : "text-subtle")}
            />
            <span
              className={cx(
                "min-w-0 flex-1",
                mark === "removed" ? "text-muted line-through decoration-faint" : "text-soft",
              )}
            >
              {mark && (
                <span className="sr-only">{mark === "added" ? "Added: " : "Removed: "}</span>
              )}
              {l.text}
            </span>
            {high && mark !== "removed" && (
              <Badge tone="warn" className="mt-px h-5 px-1.5">
                High risk
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The nodes the assistant may call from chat, marking the ones that send
 * something outside Sling.
 */
export function AssistantNodes({ nodes }: { nodes: ExtensionContents["nodes"] }) {
  const usable = nodes.filter((n) => n.assistant);
  if (usable.length === 0) return null;
  return (
    <section>
      <SectionHeading>The assistant can use</SectionHeading>
      <ul aria-label="The assistant can use" className="space-y-2">
        {usable.map((n) => {
          const Icon = n.assistant?.sends ? Send : BookOpen;
          return (
            <li key={n.type} className="flex items-start gap-2.5 text-[13px] leading-5">
              <Icon aria-hidden="true" size={14} className="mt-[3px] shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 text-soft">{n.title}</span>
              {n.assistant?.sends && <Badge className="mt-px h-5 px-1.5">Sends</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A heading inside a dialog section. */
export function SectionHeading({ children }: { children: string }) {
  return <h3 className="section-label mb-2.5">{children}</h3>;
}
