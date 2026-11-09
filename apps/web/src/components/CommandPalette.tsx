import type { WorkflowSummaryView } from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CornerDownLeft,
  type LucideIcon,
  MessageSquare,
  Moon,
  Search,
  SquarePen,
  Sun,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useRecentConversations } from "../lib/conversations.ts";
import { setTheme, useTheme } from "../lib/theme.ts";
import { qk } from "../lib/workflowApi.ts";
import { NAV } from "./nav.ts";
import { cx, Kbd } from "./ui.tsx";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

/** Jump to a page, a conversation, or a workflow. Opens with ⌘K or the header's search button. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const conversations = useRecentConversations();
  const workflows = useQuery({
    queryKey: qk.workflows(),
    queryFn: () => api.get<WorkflowSummaryView[]>("/api/workflows"),
  });

  const items = useMemo<Item[]>(() => {
    const go = (to: string, params?: Record<string, string>) => () => {
      void navigate({ to, params } as never);
      onClose();
    };
    const all: Item[] = [
      { id: "new", group: "Actions", label: "New chat", icon: SquarePen, run: go("/") },
      {
        id: "theme",
        group: "Actions",
        label: theme === "light" ? "Switch to dark theme" : "Switch to light theme",
        icon: theme === "light" ? Moon : Sun,
        run: () => {
          setTheme(theme === "light" ? "dark" : "light");
          onClose();
        },
      },
      ...NAV.map((n) => ({
        id: `nav:${n.to}`,
        group: "Pages",
        label: n.label,
        icon: n.icon,
        run: go(n.to),
      })),
      ...(conversations.data?.items ?? []).slice(0, 30).map((c) => ({
        id: `c:${c.id}`,
        group: "Conversations",
        label: c.title,
        icon: MessageSquare,
        run: go("/c/$id", { id: c.id }),
      })),
      ...(workflows.data ?? []).map((w) => ({
        id: `w:${w.id}`,
        group: "Workflows",
        label: w.name,
        hint: w.enabled ? undefined : "Off",
        icon: Workflow,
        run: go("/workflows/$id", { id: w.id }),
      })),
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
  }, [query, conversations.data, workflows.data, navigate, onClose, theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the cursor when the query changes.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overscroll-contain px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        className="anim-fade absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="anim-pop relative w-full max-w-xl overflow-hidden rounded-2xl bg-surface shadow-popover"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search aria-hidden="true" size={16} className="text-subtle" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                items[active]?.run();
              }
            }}
            placeholder="Search pages, conversations, workflows"
            aria-label="Search"
            aria-controls="palette-results"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle focus-visible:outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div
          ref={list}
          id="palette-results"
          role="listbox"
          className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-1.5"
        >
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-muted">Nothing matches.</p>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup;
            lastGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {header && (
                  <div className="px-2.5 pt-2.5 pb-1 text-xs text-subtle">{item.group}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={item.run}
                  className={cx(
                    "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]",
                    i === active ? "bg-surface-3 text-text" : "text-soft",
                  )}
                >
                  <Icon aria-hidden="true" className={i === active ? "text-icon" : "text-subtle"} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-xs text-subtle">{item.hint}</span>}
                  {i === active && (
                    <CornerDownLeft aria-hidden="true" size={12} className="text-subtle" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
