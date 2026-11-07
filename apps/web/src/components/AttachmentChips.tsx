import type { SourceView } from "@sling/core";
import { CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { kindIcon, sourceDetail } from "../lib/sources.ts";
import type { Attachment, Attachments } from "../lib/useAttachments.ts";
import { cx, Spinner } from "./ui.tsx";

/** The files waiting to go with the next message, above its text. */
export function AttachmentChips({
  files,
  leading,
}: {
  files: Attachments;
  /** Shown first in the same row, such as the Deep research chip. */
  leading?: ReactNode;
}) {
  if (files.items.length === 0 && !leading) return null;
  return (
    <ul aria-label="Files" className="flex flex-wrap items-center gap-2 px-3 pt-3">
      {leading && <li>{leading}</li>}
      {files.items.map((a) => (
        <li key={a.key}>
          {a.image && a.preview && a.state !== "failed" ? (
            <ImageChip a={a} onRemove={() => files.remove(a.key)} />
          ) : (
            <FileChip a={a} onRemove={() => files.remove(a.key)} />
          )}
        </li>
      ))}
    </ul>
  );
}

function RemoveButton({
  name,
  onRemove,
  floating,
}: {
  name: string;
  onRemove: () => void;
  floating?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${name}`}
      title="Remove"
      className={cx(
        "pressable grid cursor-pointer place-items-center rounded-full transition-colors duration-150",
        floating
          ? "absolute -top-1.5 -right-1.5 size-5 bg-surface-3 text-soft shadow-raised hover:text-text"
          : "size-5 shrink-0 text-subtle hover:bg-surface-3 hover:text-text",
      )}
    >
      <X aria-hidden="true" size={12} />
    </button>
  );
}

function ImageChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const busy = a.state === "uploading";
  return (
    <div className="group relative" title={a.name}>
      <img
        src={a.preview ?? ""}
        alt={a.name}
        className={cx(
          "size-12 rounded-lg object-cover shadow-raised transition-opacity duration-150",
          busy && "opacity-50",
        )}
      />
      {busy && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-4 text-text" />
        </span>
      )}
      <RemoveButton name={a.name} onRemove={onRemove} floating />
    </div>
  );
}

function chipLine(a: Attachment): string {
  if (a.state === "failed") return a.error ?? "Couldn't read it";
  if (a.state === "uploading") return "Uploading…";
  if (a.state === "processing" || !a.source) return "Reading…";
  return sourceDetail(a.source);
}

function FileChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const failed = a.state === "failed";
  const busy = a.state === "uploading" || a.state === "processing";
  const Icon = kindIcon(
    a.source ??
      ({ kind: a.image ? "image" : "file", mediaType: "" } as Pick<
        SourceView,
        "kind" | "mediaType"
      >),
  );
  return (
    <div
      title={failed ? `${a.name}: ${a.error ?? ""}` : a.name}
      className={cx(
        "flex h-12 max-w-64 items-center gap-2.5 rounded-lg bg-surface-2 pr-1.5 pl-2 shadow-raised",
        failed && "shadow-[inset_0_0_0_1px_var(--tag-red-border)]",
      )}
    >
      <span
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-md",
          failed ? "bg-[var(--tag-red-bg)] text-danger" : "bg-surface-3 text-icon",
        )}
      >
        {busy ? (
          <Spinner className="size-3.5" />
        ) : failed ? (
          <CircleAlert aria-hidden="true" size={14} />
        ) : (
          <Icon aria-hidden="true" size={14} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{a.name}</span>
        <span
          className={cx(
            "block truncate text-[11px] leading-4",
            failed ? "text-danger" : "text-muted",
          )}
        >
          {chipLine(a)}
        </span>
      </span>
      <RemoveButton name={a.name} onRemove={onRemove} />
    </div>
  );
}
