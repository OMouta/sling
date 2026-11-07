import { Paperclip } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

/**
 * Files dragged anywhere over the page: while they're over it, an overlay
 * says they can be dropped, and a drop passes them on. A drop the composer
 * already took isn't passed on twice.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true): ReactNode {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    // dragenter and dragleave fire for every element crossed, so they're counted.
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      const taken = e.defaultPrevented;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!taken && files.length) handler.current(files);
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
      reset();
    };
  }, [enabled]);
  if (!dragging) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className="anim-fade pointer-events-none fixed inset-0 z-50 bg-bg/70 p-3 backdrop-blur-[2px]"
    >
      <div className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-accent-text/50 bg-accent/5">
        <div className="flex flex-col items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-icon shadow-raised">
            <Paperclip size={18} />
          </span>
          <p className="text-sm font-medium">Drop files to add them</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
