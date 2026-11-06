import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { offsetOf, searchTimeZones, timeZoneOptions } from "../lib/timezone.ts";
import { cx } from "./ui.tsx";

/**
 * Picks an IANA time zone: a field showing the current one, and a list with
 * a search box under it. The arrow keys move through the list and Enter picks.
 */
export function TimeZonePicker({
  value,
  onChange,
  labelledBy,
  disabled,
}: {
  value: string | null;
  onChange: (timeZone: string) => void;
  labelledBy?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };

  return (
    <div ref={root} className="relative w-full max-w-sm">
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg bg-field px-2.5 text-left text-[13px] text-text shadow-field outline-none transition-shadow duration-150 hover:shadow-field-hover focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate">
          {value ? value.replace(/_/g, " ") : "Not set"}
        </span>
        {value && <span className="tabular shrink-0 text-xs text-subtle">{offsetOf(value)}</span>}
        <ChevronDown aria-hidden="true" className="shrink-0 text-subtle" />
      </button>
      {open && (
        <ZoneList
          value={value}
          onPick={(tz) => {
            close();
            if (tz !== value) onChange(tz);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

function ZoneList({
  value,
  onPick,
  onClose,
}: {
  value: string | null;
  onPick: (tz: string) => void;
  onClose: () => void;
}) {
  const all = useMemo(() => timeZoneOptions(), []);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => searchTimeZones(all, query), [all, query]);
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      all.findIndex((o) => o.id === value),
    ),
  );
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  // A new search starts at its first match.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the query changes.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setCursor(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <div className="anim-pop absolute top-full right-0 left-0 z-40 mt-1.5 flex max-h-80 flex-col overflow-hidden rounded-xl bg-surface shadow-popover">
      <div className="mx-3 flex shrink-0 items-center gap-2 border-b-2 border-accent-text/60 transition-colors duration-150 focus-within:border-accent-text">
        <Search aria-hidden="true" size={15} className="text-subtle" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setCursor((c) => Math.min(rows.length - 1, Math.max(0, c + step)));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[cursor];
              if (row) onPick(row.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search cities or offsets..."
          aria-label="Search time zones"
          aria-controls="time-zones"
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle focus-visible:outline-none"
        />
      </div>
      <div
        ref={list}
        id="time-zones"
        role="listbox"
        aria-label="Time zones"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-[13px] text-muted">No time zones match.</p>
        ) : (
          rows.map((o, i) => (
            <div
              key={o.id}
              data-index={i}
              role="option"
              aria-selected={o.id === value}
              tabIndex={-1}
              onMouseMove={() => setCursor(i)}
              onClick={() => onPick(o.id)}
              onKeyDown={() => {}}
              className={cx(
                "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px]",
                i === cursor ? "bg-surface-3 text-text" : "text-soft",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <span className="tabular shrink-0 text-xs text-subtle">{o.offset}</span>
              <Check
                aria-hidden="true"
                size={14}
                className={cx("shrink-0", o.id === value ? "text-text" : "invisible")}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
