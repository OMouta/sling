import type { ConversationSummaryView } from "@sling/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Plus, Search, SearchX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConversationMenu } from "../components/ConversationMenu.tsx";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, Toolbar } from "../components/Page.tsx";
import {
  Badge,
  Button,
  Card,
  Dot,
  Empty,
  ErrorText,
  Skeleton,
  Spinner,
  Tabs,
} from "../components/ui.tsx";
import {
  activityAt,
  type ConversationFilter,
  conversationStatus,
  FILTERS,
  groupByDate,
  useConversations,
} from "../lib/conversations.ts";
import { ago } from "../lib/format.ts";
import { chatsRoute } from "../router.tsx";

const SOURCE_LABEL: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
};

/** Every chat: search what was said, filter by what's going on, rename or delete. */
export function ChatsPage() {
  const navigate = useNavigate();
  const search = chatsRoute.useSearch();
  const [text, setText] = useState(search.q ?? "");
  const [q, setQ] = useState(search.q ?? "");
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const { menu, dialog } = useConversationMenu();

  // Search once typing pauses, and keep it in the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim());
      void navigate({
        to: "/chats",
        search: text.trim() ? { q: text.trim() } : {},
        replace: true,
      });
    }, 250);
    return () => clearTimeout(t);
  }, [text, navigate]);

  const conversations = useConversations(q);
  const all = conversations.data ?? [];
  const rows = all.filter(FILTERS[filter]);
  const groups = useMemo(() => groupByDate(rows), [rows]);
  const count = (f: ConversationFilter) => all.filter(FILTERS[f]).length;

  return (
    <Page
      title="Chats"
      tabs={
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "all", label: "All chats" },
            { id: "waiting", label: "Waiting for you", count: count("waiting") },
            { id: "working", label: "Working", count: count("working") },
            { id: "tasks", label: "With tasks" },
          ]}
        />
      }
      toolbar={
        <Toolbar
          actions={
            <Button variant="primary" icon={Plus} onClick={() => void navigate({ to: "/" })}>
              New chat
            </Button>
          }
        >
          <label className="relative block w-full max-w-sm">
            <Search
              aria-hidden="true"
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle"
            />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Search chats"
              placeholder="Search names and messages"
              className="h-[30px] w-full rounded-full bg-field pr-3 pl-8 text-[13px] shadow-field outline-none placeholder:text-subtle focus-visible:shadow-focus"
            />
          </label>
        </Toolbar>
      }
    >
      <div className="w-full px-5 pt-1 pb-10">
        <ErrorText error={conversations.error} />
        {conversations.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : rows.length === 0 ? (
          <Card>
            {q || filter !== "all" ? (
              <Empty icon={SearchX} title="No chats match" className="py-12" />
            ) : (
              <Empty icon={MessagesSquare} title="No chats yet" className="py-12" />
            )}
          </Card>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="mt-4 first:mt-0">
              <h2 className="section-label mb-2 px-1">{g.label}</h2>
              {/* Not clipped, so a row's menu can open past the card. */}
              <Card className="divide-y divide-border">
                {g.items.map((c) => (
                  <ChatRow key={c.id} c={c} menu={menu(c)} />
                ))}
              </Card>
            </section>
          ))
        )}
      </div>
      {dialog}
    </Page>
  );
}

function ChatRow({ c, menu }: { c: ConversationSummaryView; menu: React.ReactNode }) {
  const who = c.previewRole === "user" ? "You: " : c.previewRole === "system" ? "Sling: " : "";
  return (
    <div className="group relative flex items-start gap-3 px-4 py-3 transition-colors duration-150 first:rounded-t-[inherit] last:rounded-b-[inherit] hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to="/c/$id"
            params={{ id: c.id }}
            className="min-w-0 truncate text-[13px] font-medium after:absolute after:inset-0"
          >
            {c.title}
          </Link>
          <ChatStatusMark c={c} />
        </div>
        {c.preview && (
          <p className="mt-0.5 truncate text-xs text-muted">
            <span className="text-subtle">{who}</span>
            {c.preview}
          </p>
        )}
        {(c.waiting || c.taskCount > 0 || c.source !== "app" || c.mode === "full-access") && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {c.waiting && (
              <Badge tone="warn" dot>
                Waiting for you
              </Badge>
            )}
            {c.taskCount > 0 && (
              <Badge tone={c.activeTasks > 0 ? "accent" : "neutral"}>
                {c.activeTasks > 0
                  ? `${c.activeTasks} of ${c.taskCount} tasks running`
                  : `${c.taskCount} task${c.taskCount === 1 ? "" : "s"}`}
              </Badge>
            )}
            {c.source !== "app" && <Badge>{SOURCE_LABEL[c.source] ?? c.source}</Badge>}
            {c.mode === "full-access" && <ModeBadge mode={c.mode} />}
          </div>
        )}
      </div>
      <span className="tabular shrink-0 pt-0.5 text-xs text-subtle">{ago(activityAt(c))}</span>
      <div className="relative z-10 -my-0.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 focus-within:opacity-100">
        {menu}
      </div>
    </div>
  );
}

/** What a chat is doing, as a small mark at the end of its row. */
function ChatStatusMark({ c }: { c: ConversationSummaryView }) {
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
