import type { NodeSpecView } from "@sling/workflow";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoryColor } from "../../lib/workflow/catalog.ts";
import { useGraphStore } from "../../lib/workflow/store.ts";
import { cx } from "../ui.tsx";
import { NODE_DND_TYPE } from "./Canvas.tsx";

function matches(spec: NodeSpecView, q: string): boolean {
  if (!q) return true;
  const hay =
    `${spec.title} ${spec.type} ${spec.description} ${spec.connector ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/**
 * Every kind of step, by category, with what each one does. Click one to add
 * it, or drag it onto the canvas. `triggers` lists only what can start a run.
 */
export function AddStepMenu({
  onPick,
  onClose,
  triggers = false,
  title,
  after,
}: {
  onPick: (spec: NodeSpecView) => void;
  onClose: () => void;
  triggers?: boolean;
  title: string;
  /** The selected step a new one would follow. */
  after?: string | null;
}) {
  const store = useGraphStore();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);

  const groups = useMemo(() => {
    const visible = store.catalog.nodes.filter(
      (n) => matches(n, query.trim()) && (!triggers || n.isTrigger),
    );
    const known = new Set<string>(CATEGORY_ORDER);
    const cats = [
      ...CATEGORY_ORDER,
      ...new Set(visible.map((n) => n.category).filter((c) => !known.has(c))),
    ];
    return cats
      .map((cat) => ({
        cat,
        nodes: visible
          .filter((n) => n.category === cat)
          .sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .filter((g) => g.nodes.length > 0);
  }, [store.catalog.nodes, query, triggers]);
  const flat = groups.flatMap((g) => g.nodes);

  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top when the list changes.
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      onPick(flat[cursor]);
    }
  };

  let index = -1;
  return (
    <div
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      className="anim-pop flex max-h-full w-[360px] max-w-[calc(100vw-2rem)] origin-top-left flex-col overflow-hidden rounded-2xl bg-surface shadow-popover"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search steps"
          placeholder={triggers ? "What should start it?" : "Search steps"}
          className="h-11 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
        />
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-surface-3 hover:text-icon"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      {!triggers && after && (
        <p className="truncate border-b border-border px-3 py-2 text-xs text-muted">
          Adds after "{after}"
        </p>
      )}
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted">No steps match.</p>
        )}
        {groups.map(({ cat, nodes }) => (
          <section key={cat} className="pb-1">
            <h3 className="flex items-center gap-2 px-2 pt-2 pb-1 text-[11px] font-medium text-subtle">
              <span
                aria-hidden="true"
                className="inline-block size-2 rounded-[3px]"
                style={{ background: categoryColor(cat) }}
              />
              {CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] ?? cat}
            </h3>
            {nodes.map((spec) => {
              index += 1;
              const i = index;
              return (
                <button
                  key={spec.type}
                  type="button"
                  data-index={i}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NODE_DND_TYPE, spec.type);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => onPick(spec)}
                  className={cx(
                    "block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-colors duration-100",
                    cursor === i && "bg-surface-3",
                  )}
                >
                  <span className="block text-[13px] font-medium text-text">{spec.title}</span>
                  {spec.description && (
                    <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted">
                      {spec.description}
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
