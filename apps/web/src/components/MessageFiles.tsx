import type { SourceView } from "@sling/core";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fileUrl, kindIcon, sourceDetail } from "../lib/sources.ts";
import { cx, Spinner } from "./ui.tsx";

/** The files a message was sent with, above its bubble. */
export function MessageFiles({ files }: { files: SourceView[] }) {
  const [open, setOpen] = useState<SourceView | null>(null);
  const images = files.filter((f) => f.kind === "image");
  const docs = files.filter((f) => f.kind !== "image");
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setOpen(f)}
              aria-label={`Open ${f.name}`}
              className="pressable cursor-zoom-in overflow-hidden rounded-xl shadow-raised"
            >
              <img
                src={fileUrl(f)}
                alt={f.name}
                loading="lazy"
                className={cx(
                  "block object-cover",
                  images.length === 1 ? "max-h-56 max-w-64" : "size-28",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {docs.map((f) => (
            <DocumentChip key={f.id} file={f} />
          ))}
        </div>
      )}
      {open && <Lightbox file={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DocumentChip({ file }: { file: SourceView }) {
  const Icon = kindIcon(file);
  const failed = file.state === "failed";
  return (
    <a
      href={fileUrl(file)}
      target="_blank"
      rel="noreferrer"
      title={failed ? `${file.name}: ${file.error ?? ""}` : file.name}
      className="pressable flex h-11 max-w-60 items-center gap-2.5 rounded-xl bg-surface-2 pr-3 pl-2 shadow-raised transition-shadow duration-150 hover:shadow-raised-hover"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-3 text-icon">
        {file.state === "processing" ? (
          <Spinner className="size-3.5" />
        ) : (
          <Icon aria-hidden="true" size={14} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{file.name}</span>
        <span
          className={cx(
            "block truncate text-[11px] leading-4",
            failed ? "text-danger" : "text-muted",
          )}
        >
          {failed
            ? (file.error ?? "Couldn't read it")
            : file.state === "processing"
              ? "Reading…"
              : sourceDetail(file)}
        </span>
      </span>
    </a>
  );
}

/** An image at full size, over the page. Escape, a click, or × closes it. */
function Lightbox({ file, onClose }: { file: SourceView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="anim-fade fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 sm:p-10"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-zoom-out"
      />
      <img
        src={fileUrl(file)}
        alt={file.name}
        className="anim-pop relative max-h-full max-w-full rounded-lg object-contain shadow-popover"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="pressable absolute top-3 right-3 grid size-8 cursor-pointer place-items-center rounded-full bg-black/50 text-white transition-colors duration-150 hover:bg-black/70"
      >
        <X aria-hidden="true" size={16} />
      </button>
    </div>,
    document.body,
  );
}
