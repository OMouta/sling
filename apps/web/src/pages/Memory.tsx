import { MEMORY_TEXT_MAX, type MemoryView, type PersonalityView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brain, Check, Ellipsis, MessageSquare, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type KeyboardEvent, useDeferredValue, useEffect, useRef, useState } from "react";
import { Glyph } from "../components/Glyph.tsx";
import { Page, Toolbar } from "../components/Page.tsx";
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorText,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Skeleton,
} from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { sendsOnEnter } from "../lib/keys.ts";
import {
  applyMemoryEvent,
  MEMORY_LIST_MAX,
  matchesMemory,
  memoryApi,
  useMemories,
  useMemorySearch,
} from "../lib/memory.ts";
import { usePersonalities } from "../lib/personalities.ts";

export function MemoryPage() {
  const list = useMemories();
  const personalities = usePersonalities().data ?? [];
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  // A long list renders a page at a time, the next one as you scroll to it.
  const [limit, setLimit] = useState(PAGE);
  const all = list.data ?? [];
  const query = useDeferredValue(q.trim());
  // The server sends the most recently used; past that, it searches the rest.
  const capped = all.length >= MEMORY_LIST_MAX;
  const server = useMemorySearch(query, capped);
  const shown = !query
    ? all
    : capped
      ? (server.data ?? [])
      : all.filter((m) => matchesMemory(m, query));

  return (
    <Page
      title="Memory"
      badge={
        all.length > 0 ? (
          <span className="tabular text-xs text-subtle">{all.length.toLocaleString()}</span>
        ) : undefined
      }
      toolbar={
        list.data && all.length === 0 ? undefined : (
          <Toolbar
            actions={
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                Add
              </Button>
            }
          >
            {all.length > 0 && (
              <span className="relative block w-64 max-sm:w-full max-sm:flex-1">
                <Search
                  aria-hidden="true"
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle"
                />
                <Input
                  type="search"
                  aria-label="Search memories"
                  placeholder="Search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQ("")}
                  className="pl-8"
                />
              </span>
            )}
          </Toolbar>
        )
      }
    >
      <ErrorText error={list.error} />
      {list.isPending ? (
        <div className="space-y-3 px-5 pt-1 pb-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : all.length === 0 && !adding ? (
        <Empty
          fill
          icon={Brain}
          title="Nothing remembered yet"
          action={
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add
            </Button>
          }
        />
      ) : (
        <div className="px-5 pt-1 pb-6">
          <Card>
            <ul aria-label="Memories" className="divide-y divide-border">
              {adding && (
                <li className="px-4 py-3">
                  <NewMemory onDone={() => setAdding(false)} />
                </li>
              )}
              {shown.slice(0, limit).map((m) => (
                <MemoryRow key={m.id} memory={m} personalities={personalities} />
              ))}
            </ul>
            {shown.length > limit && <More key={limit} onSeen={() => setLimit((n) => n + PAGE)} />}
            {query && shown.length === 0 && !(capped && server.isFetching) && (
              <p className="px-4 py-6 text-center text-[13px] text-muted">No memories match.</p>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}

/** Rows rendered at a time. */
const PAGE = 200;

/** The end of what's rendered: in view, it asks for the next page. Each page mounts a new one. */
function More({ onSeen }: { onSeen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(onSeen);
  seen.current = onSeen;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      seen.current();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) seen.current();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} aria-hidden="true" className="h-px" />;
}

function NewMemory({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (text: string) => memoryApi.add({ text }),
    onSuccess: (memory) => {
      applyMemoryEvent(qc, { type: "memory.updated", memory });
      onDone();
    },
  });
  return (
    <MemoryEditor
      initial=""
      label="New memory"
      placeholder="Something to remember about you"
      busy={add.isPending}
      error={add.error}
      onSave={(text) => add.mutate(text)}
      onCancel={onDone}
    />
  );
}

/** Text to remember: Enter saves, Escape cancels. */
function MemoryEditor({
  initial,
  label,
  placeholder,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  busy: boolean;
  error: unknown;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const clean = text.replace(/\s+/g, " ").trim();
  const left = MEMORY_TEXT_MAX - clean.length;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Grows with what's typed, from one line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it measures again whenever the text changes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    if (!clean || left < 0 || busy) return;
    if (clean === initial) onCancel();
    else onSave(clean);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsOnEnter(e)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div>
      <textarea
        ref={ref}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none rounded-lg bg-field px-2.5 py-1.5 text-[13.5px] leading-5 text-text shadow-field outline-none placeholder:text-subtle focus:shadow-focus"
      />
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {error ? (
            <ErrorText error={error} />
          ) : left < 60 ? (
            <p className={cx("tabular text-xs", left < 0 ? "text-danger" : "text-subtle")}>
              {left < 0 ? `${-left} too many` : `${left} left`}
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={!clean || left < 0}
          onClick={submit}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function MemoryRow({
  memory: m,
  personalities,
}: {
  memory: MemoryView;
  personalities: PersonalityView[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (patch: { text?: string; personalityId?: string | null }) =>
      memoryApi.update(m.id, patch),
    onSuccess: (memory) => {
      applyMemoryEvent(qc, { type: "memory.updated", memory });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => memoryApi.remove(m.id),
    onSuccess: () => applyMemoryEvent(qc, { type: "memory.removed", id: m.id }),
  });
  const pinned = m.personalityId ? personalities.find((p) => p.id === m.personalityId) : undefined;

  if (editing) {
    return (
      <li className="px-4 py-3">
        <MemoryEditor
          initial={m.text}
          label="Memory"
          busy={save.isPending}
          error={save.error}
          onSave={(text) => save.mutate({ text })}
          onCancel={() => {
            save.reset();
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className={cx("group flex items-start gap-3 px-4 py-3", remove.isPending && "opacity-50")}>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full cursor-text text-left text-[13.5px] leading-5 break-words text-text"
        >
          {m.text}
        </button>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-subtle">
          <Source memory={m} />
          {pinned && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Dot />
              <Glyph shape={pinned.shape} color={pinned.color} size={13} still />
              Only {pinned.name}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Dot />
            <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
              {ago(m.createdAt)}
            </time>
          </span>
        </p>
        <ErrorText error={save.error ?? remove.error} />
      </div>
      <Menu
        label={`Memory: ${m.text.slice(0, 40)}`}
        className="-mr-1.5 shrink-0"
        trigger={({ open, toggle }) => (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={Ellipsis}
            aria-label="Memory options"
            aria-expanded={open}
            onClick={toggle}
            className={cx(
              "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 pointer-coarse:opacity-100",
              open && "sm:opacity-100",
            )}
          />
        )}
      >
        <MenuItem icon={Pencil} onSelect={() => setEditing(true)}>
          Edit
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Who knows it</MenuLabel>
        <MenuItem
          onSelect={() => m.personalityId && save.mutate({ personalityId: null })}
          trailing={!m.personalityId && <Check size={14} className="text-accent" />}
        >
          Every personality
        </MenuItem>
        {personalities.map((p) => (
          <MenuItem
            key={p.id}
            onSelect={() => m.personalityId !== p.id && save.mutate({ personalityId: p.id })}
            trailing={m.personalityId === p.id && <Check size={14} className="text-accent" />}
          >
            <span className="flex items-center gap-2">
              <Glyph shape={p.shape} color={p.color} size={14} still />
              Only {p.name}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => remove.mutate()}>
          Delete
        </MenuItem>
      </Menu>
    </li>
  );
}

/** Between two facts on a line. It wraps with the fact after it, so no line ends on one. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

/** Where a memory came from: the chat it was said in, or the page. */
function Source({ memory: m }: { memory: MemoryView }) {
  if (m.source.kind === "manual") return <span>Added by you</span>;
  if (!m.source.conversationId) return <span>From a deleted chat</span>;
  return (
    <Link
      to="/c/$id"
      params={{ id: m.source.conversationId }}
      className="inline-flex min-w-0 items-center gap-1 text-muted hover:text-text"
    >
      <MessageSquare aria-hidden="true" size={12} className="shrink-0" />
      <span className="max-w-[24rem] truncate">{m.source.conversationTitle ?? "A chat"}</span>
    </Link>
  );
}
