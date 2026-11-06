import type { AssistantChoice, ChatSettings, PermissionMode, PersonalityView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ActivityContext,
  ReplySteps,
  startedTaskId,
  WorkingLine,
} from "../components/ChatActivity.tsx";
import { ChatMarkdown } from "../components/ChatMarkdown.tsx";
import { useModeChange } from "../components/ConfirmFullAccess.tsx";
import { Glyph } from "../components/Glyph.tsx";
import { Logo } from "../components/Logo.tsx";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { Badge, Button, cx, Dot, ErrorText, Skeleton, type Tone } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { CHAT_WIDTH, useModelCatalog } from "../lib/models.ts";
import { usePersonalities } from "../lib/personalities.ts";
import { seedLiveReply, useLiveReply } from "../lib/realtime.ts";
import type { ConversationDetail, MessageView, TaskView } from "../lib/types.ts";
import { chatRoute } from "../router.tsx";

type Item =
  | { kind: "message"; at: string; message: MessageView }
  | { kind: "task"; at: string; task: TaskView };

export function ChatPage() {
  const { id } = chatRoute.useParams();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`),
  });
  const live = useLiveReply(id);
  // For a turn already running when the page opened, before its first event.
  const [openedAt] = useState(Date.now);
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Follow new content only while the reader is at the bottom.
  const following = useRef(true);

  // A reply already being written when the page opened shows its work so far.
  const seed = detail.data?.agentStatus === "thinking" ? detail.data.live : null;
  useEffect(() => {
    if (seed) seedLiveReply(id, seed);
  }, [id, seed]);

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post(`/api/conversations/${id}/messages`, { text: message }),
    onSuccess: () => setText(""),
  });
  const setMode = useMutation({
    mutationFn: (mode: PermissionMode) => api.patch(`/api/conversations/${id}`, { mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", id] }),
  });
  const modeChange = useModeChange((mode) => setMode.mutate(mode));
  const catalog = useModelCatalog();
  const personalities = usePersonalities();
  // Choices apply right away in the UI; the server stores them for the next turn.
  const setSettings = useMutation({
    mutationFn: (settings: Partial<ChatSettings>) =>
      api.patch(`/api/conversations/${id}`, { settings }),
    onMutate: (settings) => {
      qc.setQueryData<ConversationDetail>(["conversation", id], (d) =>
        d
          ? {
              ...d,
              conversation: {
                ...d.conversation,
                settings: {
                  assistant: d.conversation.settings?.assistant ?? null,
                  agent: d.conversation.settings?.agent ?? null,
                  ...settings,
                },
              },
            }
          : d,
      );
    },
    onError: () => qc.invalidateQueries({ queryKey: ["conversation", id] }),
  });

  const tasks = useMemo(
    () => new Map<string, TaskView>((detail.data?.tasks ?? []).map((t) => [t.id, t])),
    [detail.data?.tasks],
  );

  // Tasks the assistant started show inside its reply, where it started them.
  // The rest, such as tasks a workflow started, show by when they began.
  const items = useMemo<Item[]>(() => {
    if (!detail.data) return [];
    const inline = new Set<string>();
    for (const step of [
      ...detail.data.messages.flatMap((m) => m.trace?.steps ?? []),
      ...(live?.steps ?? []),
    ]) {
      const taskId = startedTaskId(step);
      if (taskId) inline.add(taskId);
    }
    const list: Item[] = [
      ...detail.data.messages.map((m) => ({
        kind: "message" as const,
        at: m.createdAt,
        message: m,
      })),
      ...detail.data.tasks
        .filter((t) => !inline.has(t.id))
        .map((t) => ({ kind: "task" as const, at: t.createdAt, task: t })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [detail.data, live?.steps]);

  // Keep the newest content in view while the reader is at the bottom. The
  // composer floats over the end of the page, so this scrolls all the way.
  const loaded = detail.data !== undefined;
  useEffect(() => {
    const scroller = loaded ? bottom.current?.closest(".overflow-y-auto") : null;
    if (!scroller) return;
    const onScroll = () => {
      following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [loaded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content grows.
  useLayoutEffect(() => {
    const scroller = bottom.current?.closest(".overflow-y-auto");
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [items, live]);

  // Grow the composer with its text, up to a limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure when the text changes.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text]);

  if (detail.isPending) {
    return (
      <Page title={<Skeleton className="h-4 w-48" />}>
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-8">
          <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Page>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Page title="Conversation">
        <div className="p-5">
          <ErrorText error={detail.error ?? "Conversation not found."} />
        </div>
      </Page>
    );
  }

  const { conversation, agentStatus, usage } = detail.data;
  // The list has the latest look; the chat's own copy covers a deleted personality.
  const personality =
    personalities.data?.find((p) => p.id === detail.data.personality?.id) ??
    detail.data.personality;
  const hasTools = (personality?.tools.length ?? 1) > 0;
  const thinking = agentStatus === "thinking";
  const tokens = usage.inputTokens + usage.outputTokens;

  const assistant: AssistantChoice | null =
    conversation.settings?.assistant ?? catalog.data?.defaults.assistant ?? null;
  const activity: ActivityContext = {
    conversationId: conversation.id,
    conversationMode: conversation.mode,
    tasks,
  };
  const liveSteps = live?.steps ?? [];
  const lastLive = liveSteps.at(-1);
  // Something already shows it's working: a running tool, or thinking as it comes.
  const busyStep =
    lastLive?.kind === "thinking" || (lastLive?.kind === "tool" && lastLive.status === "running");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || send.isPending) return;
    following.current = true;
    send.mutate(t);
  };

  return (
    <Page
      title={conversation.title}
      badge={
        <span className="flex items-center gap-2">
          {personality && (
            <span
              className="flex h-[22px] items-center gap-1.5 rounded-full bg-surface-2 pr-2 pl-1.5 text-xs text-soft shadow-raised"
              title={personality.description || personality.name}
            >
              <Glyph
                shape={personality.shape}
                color={personality.color}
                size={13}
                seed={personality.id}
                active={thinking}
              />
              <span className="max-w-32 truncate">{personality.name}</span>
            </span>
          )}
          {thinking && (
            <Badge tone="accent" dot>
              Thinking
            </Badge>
          )}
        </span>
      }
      controls={
        tokens > 0 && (
          <span className="tabular text-xs text-subtle max-lg:hidden">
            {tokens.toLocaleString()} tokens
          </span>
        )
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="w-full flex-1 px-5 py-8">
          <div className={cx("mx-auto space-y-6", CHAT_WIDTH)}>
            {items.map((item) =>
              item.kind === "task" ? (
                <TaskCard
                  key={item.task.id}
                  task={item.task}
                  compact
                  conversationMode={conversation.mode}
                />
              ) : (
                <Message
                  key={item.message.id}
                  message={item.message}
                  activity={activity}
                  tasks={tasks}
                  personality={personality}
                />
              ),
            )}
            {thinking && (
              <AssistantRow personality={personality} active>
                <ReplySteps steps={liveSteps} live ctx={activity} />
                {!live?.text && !busyStep && (
                  <WorkingLine startedAt={live?.startedAt ?? openedAt} />
                )}
                {live?.text ? (
                  <div className="prose-chat text-sm leading-6">
                    <ChatMarkdown>{live.text}</ChatMarkdown>
                  </div>
                ) : null}
              </AssistantRow>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <form
          onSubmit={submit}
          className="sticky bottom-0 bg-gradient-to-t from-bg from-60% to-transparent px-5 pt-4 pb-5"
        >
          <div className={cx("mx-auto", CHAT_WIDTH)}>
            <div className="rounded-2xl bg-surface shadow-card transition-shadow duration-150 has-[textarea:focus]:shadow-focus">
              <textarea
                ref={input}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) submit(e);
                }}
                aria-label="Message"
                placeholder={`Message ${personality?.name ?? "Sling"}`}
                className="block min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-5 outline-none placeholder:text-subtle focus-visible:outline-none"
              />
              <div className="flex items-center gap-2 px-2 pb-2">
                <ChatControls
                  className="min-w-0 flex-1"
                  catalog={catalog.data}
                  assistant={assistant}
                  onAssistant={(choice) => setSettings.mutate({ assistant: choice })}
                  // The mode only limits tools, so a personality without any has no use for it.
                  {...(hasTools ? { mode: conversation.mode, onMode: modeChange.change } : {})}
                />
                <Button
                  type="submit"
                  variant="primary"
                  iconOnly
                  icon={ArrowUp}
                  aria-label="Send"
                  busy={send.isPending}
                  disabled={!text.trim()}
                />
              </div>
            </div>
            <div className="mt-1.5 px-1">
              <ErrorText error={send.error ?? setMode.error ?? setSettings.error} />
            </div>
          </div>
        </form>
      </div>
      {modeChange.dialog}
    </Page>
  );
}

/**
 * An assistant reply: its work in order, then the answer. The personality's
 * glyph marks it, and moves faster while the reply is being written.
 */
function AssistantRow({
  personality,
  active = false,
  children,
}: {
  personality: PersonalityView | null | undefined;
  active?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      {personality ? (
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center">
          <Glyph
            shape={personality.shape}
            color={personality.color}
            size={22}
            seed={personality.id}
            active={active}
            still={!active}
          />
        </span>
      ) : (
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-accent text-white shadow-primary">
          <Logo className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-2.5">{children}</div>
    </div>
  );
}

const NOTE: Record<string, { text: string; tone: Tone }> = {
  succeeded: { text: "finished", tone: "ok" },
  failed: { text: "failed", tone: "danger" },
  cancelled: { text: "was cancelled", tone: "neutral" },
  rejected: { text: "was refused by the machine", tone: "danger" },
  interrupted: { text: "was interrupted", tone: "warn" },
};

/**
 * A note in the history from Sling, such as a task finishing. It says what
 * happened at the time, so a later state of the task doesn't change it.
 */
function SystemNote({ message, tasks }: { message: MessageView; tasks: Map<string, TaskView> }) {
  const first = message.text.split("\n")[0] ?? "";
  const task = message.taskIds[0] ? tasks.get(message.taskIds[0]) : undefined;
  const waiting = /Waiting for the user to approve/.test(message.text);
  const state = first.match(/: (\w+)\.$/)?.[1] ?? "";
  const note = waiting
    ? { text: "is waiting for your approval", tone: "warn" as Tone }
    : NOTE[state];
  return (
    <div className="flex items-center gap-3 text-xs text-subtle" title={message.text}>
      <span className="h-px flex-1 bg-border" />
      {task && note ? (
        <span className="flex min-w-0 items-center gap-2">
          <Dot tone={note.tone} />
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="truncate font-medium text-muted hover:text-text"
          >
            {task.title}
          </Link>
          <span className="shrink-0">{note.text}</span>
        </span>
      ) : (
        <span className="truncate">{first}</span>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Message({
  message,
  activity,
  tasks,
  personality,
}: {
  message: MessageView;
  activity: ActivityContext;
  tasks: Map<string, TaskView>;
  personality: PersonalityView | null | undefined;
}) {
  if (message.role === "system") return <SystemNote message={message} tasks={tasks} />;
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap shadow-active [overflow-wrap:anywhere]">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <AssistantRow personality={personality}>
      {message.trace && <ReplySteps steps={message.trace.steps} ctx={activity} />}
      <div className="prose-chat text-sm leading-6">
        <ChatMarkdown>{message.text}</ChatMarkdown>
      </div>
    </AssistantRow>
  );
}
