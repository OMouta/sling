import type { ConversationSummaryView } from "@sling/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, MessagesSquare, Plus, Search, SearchX } from "lucide-react";
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
  groupByDate,
  useConversationList,
} from "../lib/conversations.ts";
import { ago, plural } from "../lib/format.ts";
import { useLoadMore, useStickyCounts } from "../lib/pages.ts";
import { chatsRoute } from "../router.tsx";

const SOURCE_LABEL: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
};

/** Every chat: search what was said, filter by what's going on, rename or archive. */
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

  const conversations = useConversationList(q, filter);
  const pages = conversations.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const groups = useMemo(() => groupByDate(rows), [rows]);
  const counts = useStickyCounts(pages?.[0]?.counts);
  const end = useLoadMore(conversations);
  const { isFetchingNextPage } = conversations;

  return (
    <Page
      title="Chats"
      tabs={
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "all", label: "All chats" },
            { id: "waiting", label: "Waiting for you", count: counts?.waiting },
            { id: "working", label: "Working", count: counts?.working },
            { id: "tasks", label: "With tasks" },
            { id: "archived", label: "Archived" },
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
            {q ? (
              <Empty icon={SearchX} title="No chats match" className="py-12" />
            ) : filter === "archived" ? (
              <Empty icon={Archive} title="No archived chats" className="py-12" />
            ) : filter !== "all" ? (
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
        <div ref={end} aria-hidden="true" />
        {isFetchingNextPage && (
          <div className="flex justify-center pt-4">
            <Spinner />
          </div>
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
                  : plural(c.taskCount, "task")}
              </Badge>
            )}
            {c.source !== "app" && <Badge>{SOURCE_LABEL[c.source] ?? c.source}</Badge>}
            {c.mode === "full-access" && <ModeBadge mode={c.mode} />}
          </div>
        )}
      </div>
      <span className="tabular shrink-0 pt-0.5 text-xs text-subtle">{ago(activityAt(c))}</span>
      <div className="relative z-10 -my-0.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
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
      <span title="Thinking" className="grid size-4 place-items-center">
        <Spinner className="size-3" />
      </span>
    );
  }
  if (status === "tasks") {
    return (
      <span
        title={`${plural(c.activeTasks, "task")} running`}
        className="grid size-4 place-items-center"
      >
        <Dot tone="accent" pulse />
      </span>
    );
  }
  return null;
}
