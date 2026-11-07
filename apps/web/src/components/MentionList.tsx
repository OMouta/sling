import { useEffect, useRef } from "react";
import type { Mention } from "../lib/mentions.ts";
import { Glyph } from "./Glyph.tsx";
import { cx } from "./ui.tsx";

/** The personalities to @mention, floating above the composer while `@` is typed. */
export function MentionList({ mention }: { mention: Mention }) {
  const { options, cursor, setCursor, pick } = mention;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  if (options.length === 0) return null;
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Personalities"
      className="anim-pop absolute bottom-full left-0 z-20 mb-2 max-h-72 w-80 max-w-full origin-bottom-left overflow-y-auto rounded-xl bg-surface p-1.5 shadow-popover"
    >
      {options.map((p, i) => (
        <div
          key={p.id}
          data-index={i}
          role="option"
          aria-selected={i === cursor}
          tabIndex={-1}
          // Keeps the caret in the composer.
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => setCursor(i)}
          onClick={() => pick(p)}
          onKeyDown={() => {}}
          className={cx(
            "flex h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5",
            i === cursor ? "bg-surface-3 text-text" : "text-soft",
          )}
        >
          <Glyph
            shape={p.shape}
            color={p.color}
            size={20}
            seed={p.id}
            lively={i === cursor}
            still={i !== cursor}
            className="shrink-0"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{p.name}</span>
            {p.description && (
              <span className="block truncate text-xs text-muted">{p.description}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
