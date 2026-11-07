import type { ConversationSummaryView } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { conversationStatus, groupByDate, useConversations } from "../lib/conversations.ts";
import { useConversationMenu } from "./ConversationMenu.tsx";
import { Dot, Spinner } from "./ui.tsx";

/** How many chats the sidebar lists before pointing to the Chats page. */
const SHOWN = 30;

/** What a chat is doing, as a small mark at the end of its row. */
export function ChatStatusMark({ c }: { c: ConversationSummaryView }) {
  const status = conversationStatus(c);
  if (status === "waiting") {
    return (
      <span title="Waiting for you" className="grid size-4 place-items-center">
        <Dot tone="warn" />
      </span>
    );
  }
  if (status === "thinking") {
    return (
      <span title="Replying" className="grid size-4 place-items-center">
        <Spinner className="size-3" />
      </span>
    );
  }
  if (status === "tasks") {
    return (
      <span
        title={`${c.activeTasks} task${c.activeTasks === 1 ? "" : "s"} running`}
        className="grid size-4 place-items-center"
      >
        <Dot tone="accent" pulse />
      </span>
    );
  }
  return null;
}

/**
 * The sidebar's chats: grouped by when they last changed, with what each is
 * doing, a filter by name, and rename and delete on each row.
 */
export function SidebarChats({ onNew }: { onNew: () => void }) {
  const conversations = useConversations();
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { menu, dialog } = useConversationMenu();

  const all = conversations.data ?? [];
  const term = filter.trim().toLowerCase();
  const matches = term ? all.filter((c) => c.title.toLowerCase().includes(term)) : all;
  const shown = matches.slice(0, SHOWN);
  const groups = useMemo(() => (term ? null : groupByDate(shown)), [term, shown]);

  const row = (c: ConversationSummaryView) => (
    <div key={c.id} className="group/row relative">
      <Link
        to="/c/$id"
        params={{ id: c.id }}
        className="group flex h-[30px] items-center gap-2 rounded-lg pr-1.5 pl-2 text-sm text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
        activeProps={{ className: "active bg-surface-3 text-text! shadow-active" }}
      >
        <span className="min-w-0 flex-1 truncate">{c.title}</span>
        <span className="shrink-0 group-hover/row:invisible group-has-[[aria-expanded=true]]/row:invisible">
          <ChatStatusMark c={c} />
        </span>
      </Link>
      <div className="absolute inset-y-0 right-1 hidden items-center group-hover/row:flex group-has-[[aria-expanded=true]]/row:flex">
        {menu(c)}
      </div>
    </div>
  );

  return (
    <div className="mt-5 space-y-px">
      <div className="flex h-7 items-center justify-between gap-1 pr-1 pl-2">
        <span className="section-label">Chats</span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={filtering ? "Stop filtering chats" : "Filter chats"}
            aria-pressed={filtering}
            onClick={() => {
              if (filtering) setFilter("");
              setFiltering(!filtering);
              if (!filtering) requestAnimationFrame(() => input.current?.focus());
            }}
            className="grid size-5 cursor-pointer place-items-center rounded-md text-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-icon"
          >
            {filtering ? (
              <X aria-hidden="true" size={12} />
            ) : (
              <Search aria-hidden="true" size={12} />
            )}
          </button>
          <button
            type="button"
            aria-label="New chat"
            onClick={onNew}
            className="grid size-5 cursor-pointer place-items-center rounded-md text-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-icon"
          >
            <Plus aria-hidden="true" size={12} />
          </button>
        </span>
      </div>
      {filtering && (
        <div className="px-1 pb-1.5">
          <input
            ref={input}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                setFiltering(false);
              }
            }}
            aria-label="Filter chats by name"
            placeholder="Filter by name"
            className="h-7 w-full rounded-lg bg-field px-2.5 text-[13px] shadow-field outline-none placeholder:text-subtle focus-visible:shadow-focus"
          />
        </div>
      )}
      {groups
        ? groups.map((g) => (
            <div key={g.label} className="space-y-px pb-2">
              <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-faint">{g.label}</p>
              {g.items.map(row)}
            </div>
          ))
        : shown.map(row)}
      {all.length === 0 && conversations.isSuccess && (
        <p className="px-2 py-1.5 text-xs text-subtle">No chats yet.</p>
      )}
      {term && matches.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-subtle">No matching chats.</p>
      )}
      {(matches.length > SHOWN || all.length > 0) && (
        <Link
          to="/chats"
          search={term ? { q: filter.trim() } : {}}
          className="flex h-[28px] items-center gap-1 rounded-lg px-2 text-xs text-subtle transition-colors duration-150 hover:text-text"
        >
          {term
            ? "Search messages too"
            : matches.length > SHOWN
              ? `All ${matches.length} chats`
              : "All chats"}
          <ArrowRight aria-hidden="true" size={12} />
        </Link>
      )}
      {dialog}
    </div>
  );
}
