import type {
  AssistantChoice,
  ChatSettings,
  PermissionMode,
  PersonalityView,
  SendMessageInput,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArchiveRestore } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AttachmentChips } from "../components/AttachmentChips.tsx";
import {
  type ActivityContext,
  ReplySteps,
  startedTaskId,
  WorkingLine,
} from "../components/ChatActivity.tsx";
import { ChatMarkdown } from "../components/ChatMarkdown.tsx";
import { Composer } from "../components/Composer.tsx";
import { useModeChange } from "../components/ConfirmFullAccess.tsx";
import {
  ResearchChip,
  ResearchLine,
  ResearchSteps,
  useDeepResearch,
} from "../components/DeepResearch.tsx";
import { useFileDrop } from "../components/DropOverlay.tsx";
import { FollowUps } from "../components/FollowUps.tsx";
import { Glyph } from "../components/Glyph.tsx";
import { Logo } from "../components/Logo.tsx";
import { MentionList } from "../components/MentionList.tsx";
import { MessageFiles } from "../components/MessageFiles.tsx";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { ReplyActions } from "../components/ReplyActions.tsx";
import { ReplySources } from "../components/ReplySources.tsx";
import { StartedBy } from "../components/StartedBy.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { UserBubble } from "../components/UserBubble.tsx";
import {
  Badge,
  Button,
  cx,
  Dot,
  ErrorText,
  Skeleton,
  Spinner,
  type Tone,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { conversationsKey } from "../lib/conversations.ts";
import { useDictation } from "../lib/dictation.ts";
import { useDraft, useSendId } from "../lib/drafts.ts";
import { replyAuthor, useMention } from "../lib/mentions.ts";
import { CHAT_WIDTH, useModelCatalog } from "../lib/models.ts";
import { usePersonalities } from "../lib/personalities.ts";
import { seedLiveReply, useLiveReply } from "../lib/realtime.ts";
import { canResearch } from "../lib/research.ts";
import type { ConversationDetail, MessageView, OlderMessages, TaskView } from "../lib/types.ts";
import { useAttachments } from "../lib/useAttachments.ts";
import { chatRoute } from "../router.tsx";

type Item =
  | { kind: "message"; at: string; message: MessageView }
  | { kind: "task"; at: string; task: TaskView };

export function ChatPage() {
  const { id } = chatRoute.useParams();
  const qc = useQueryClient();
  // A refresh asks for every message from the oldest one loaded, so what
  // the reader scrolled back to stays.
  const detail = useQuery({
    queryKey: ["conversation", id],
    queryFn: ({ signal }) => {
      const from = qc.getQueryData<ConversationDetail>(["conversation", id])?.messages[0]?.id;
      return api.get<ConversationDetail>(
        `/api/conversations/${id}${from ? `?from=${encodeURIComponent(from)}` : ""}`,
        { signal },
      );
    },
  });
  const live = useLiveReply(id);
  // For a turn already running when the page opened, before its first event.
  const [openedAt] = useState(Date.now);
  const [text, setText] = useDraft(id);
  const dictation = useDictation(text, setText);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Follow new content only while the reader is at the bottom.
  const following = useRef(true);

  // A reply already being written when the page opened shows its work so far.
  const seed = detail.data?.agentStatus === "thinking" ? detail.data.live : null;
  useEffect(() => {
    if (seed) seedLiveReply(id, seed);
  }, [id, seed]);

  const research = useDeepResearch();
  const files = useAttachments();
  const dropOverlay = useFileDrop(files.add);
  // Sending the same message again after a failure keeps its ID, so the
  // server saves it once even if the first try got there.
  const sendId = useSendId();
  const send = useMutation({
    mutationFn: async (message: SendMessageInput) => {
      const attachmentIds = await files.ids();
      const clientId = sendId.take(JSON.stringify([id, message, attachmentIds]));
      return api.post(`/api/conversations/${id}/messages`, {
        ...message,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        clientId,
      });
    },
    onSuccess: () => {
      sendId.done();
      setText("");
      research.off();
      files.clear();
    },
  });
  const restore = useMutation({
    mutationFn: () => api.post(`/api/conversations/${id}/restore`),
    onSuccess: () => {
      qc.setQueryData<ConversationDetail>(["conversation", id], (d) =>
        d ? { ...d, conversation: { ...d.conversation, archived: false } } : d,
      );
      void qc.invalidateQueries({ queryKey: conversationsKey });
    },
  });
  // A follow-up goes out on its own, leaving a draft and its files in the composer.
  const followUp = useMutation({
    mutationFn: (message: string) =>
      api.post(`/api/conversations/${id}/messages`, { text: message }),
  });
  const setMode = useMutation({
    mutationFn: (mode: PermissionMode) => api.patch(`/api/conversations/${id}`, { mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", id] }),
  });
  const modeChange = useModeChange((mode) => setMode.mutate(mode));
  const catalog = useModelCatalog();
  const personalities = usePersonalities();
  const mention = useMention({
    text,
    setText,
    inputRef: input,
    personalities: (personalities.data ?? []).filter((p) => p.id !== detail.data?.personality?.id),
  });
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

  // Older messages load as the reader scrolls up, and the view stays where
  // it was: `anchor` is the distance from the bottom before they came in.
  const top = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const olderCursor = detail.data?.olderCursor ?? null;
  const older = useMutation({
    mutationFn: (before: string) =>
      api.get<OlderMessages>(
        `/api/conversations/${id}/messages?before=${encodeURIComponent(before)}`,
      ),
    onSuccess: (page) =>
      qc.setQueryData<ConversationDetail>(["conversation", id], (d) => {
        if (!d) return d;
        const have = new Set(d.messages.map((m) => m.id));
        const known = new Set(d.tasks.map((t) => t.id));
        return {
          ...d,
          messages: [...page.messages.filter((m) => !have.has(m.id)), ...d.messages],
          tasks: [...page.tasks.filter((t) => !known.has(t.id)), ...d.tasks],
          olderCursor: page.olderCursor,
        };
      }),
    onError: () => {
      anchor.current = null;
    },
  });
  const loadingOlder = older.isPending;
  const loadOlder = older.mutate;
  useEffect(() => {
    const el = top.current;
    const scroller = el?.closest(".overflow-y-auto");
    if (!el || !scroller || !olderCursor || loadingOlder) return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        anchor.current = scroller.scrollHeight - scroller.scrollTop;
        loadOlder(olderCursor);
      },
      { root: scroller, rootMargin: "600px 0px 0px 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [olderCursor, loadingOlder, loadOlder]);
  const firstId = detail.data?.messages[0]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the place when older messages arrive.
  useLayoutEffect(() => {
    const scroller = top.current?.closest(".overflow-y-auto");
    if (!scroller || anchor.current === null) return;
    scroller.scrollTop = scroller.scrollHeight - anchor.current;
    anchor.current = null;
  }, [firstId]);

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
  const lastTurn = usage.lastTurn;

  const assistant: AssistantChoice | null =
    conversation.settings?.assistant ??
    personality?.assistant ??
    catalog.data?.defaults.assistant ??
    null;
  // A mention's turn runs as that personality, on its own model when it has one.
  const researchable = mention.mentioned
    ? canResearch(mention.mentioned, mention.mentioned.assistant ?? assistant)
    : canResearch(personality, assistant);
  const researching =
    thinking && detail.data.messages.findLast((m) => m.role === "user")?.research === true;
  const activity: ActivityContext = {
    conversationId: conversation.id,
    conversationMode: conversation.mode,
    tasks,
  };
  const lastReplyId = detail.data.messages.findLast((m) => m.role !== "system")?.id;
  // A turn answering an @mention is that personality's.
  const mentioned = detail.data.messages.findLast((m) => m.role === "user")?.personalityId;
  const answering =
    (mentioned && personalities.data?.find((p) => p.id === mentioned)) || personality;
  const liveSteps = live?.steps ?? [];
  const lastLive = liveSteps.at(-1);
  // Something already shows it's working: a running tool, or thinking as it comes.
  const busyStep =
    lastLive?.kind === "thinking" || (lastLive?.kind === "tool" && lastLive.status === "running");

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
          {conversation.startedBy && <StartedBy by={conversation.startedBy} />}
          {conversation.archived && <Badge>Archived</Badge>}
          {thinking && (
            <Badge tone="accent" dot>
              Thinking
            </Badge>
          )}
        </span>
      }
      controls={
        (conversation.archived || lastTurn) && (
          <span className="flex items-center gap-3">
            {lastTurn && (
              <span
                className="tabular text-xs text-subtle max-lg:hidden"
                title={`The last reply read ${lastTurn.inputTokens.toLocaleString()} tokens, cached ones included, and wrote ${lastTurn.outputTokens.toLocaleString()}. ${tokens.toLocaleString()} across the chat.`}
              >
                Last reply {compactNumber.format(lastTurn.inputTokens + lastTurn.outputTokens)}{" "}
                tokens
              </span>
            )}
            {conversation.archived && (
              <Button
                size="sm"
                icon={ArchiveRestore}
                busy={restore.isPending}
                onClick={() => restore.mutate()}
              >
                Restore
              </Button>
            )}
          </span>
        )
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="w-full flex-1 px-5 py-8">
          {olderCursor && (
            <div ref={top} className="-mt-4 flex h-8 items-start justify-center">
              {older.isPending ? (
                <Spinner />
              ) : older.isError ? (
                <Button size="sm" variant="ghost" onClick={() => older.mutate(olderCursor)}>
                  Load earlier messages
                </Button>
              ) : null}
            </div>
          )}
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
                  personalities={personalities.data}
                  latest={!thinking && item.message.id === lastReplyId}
                  onSend={(t) => {
                    following.current = true;
                    followUp.mutate(t);
                  }}
                />
              ),
            )}
            {thinking && (
              <AssistantRow
                personality={answering}
                name={answering !== personality ? answering?.name : undefined}
                active
              >
                <ReplySteps steps={liveSteps} live ctx={activity} />
                {researching && !live?.text && (
                  <ResearchLine steps={liveSteps} startedAt={live?.startedAt ?? openedAt} />
                )}
                {!researching && !live?.text && !busyStep && (
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

        <div className="sticky bottom-0 bg-gradient-to-t from-bg from-60% to-transparent px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className={cx("mx-auto", CHAT_WIDTH)}>
            <Composer
              variant="reply"
              text={text}
              setText={setText}
              onSubmit={() => {
                following.current = true;
                dictation.cancel();
                send.mutate({
                  text: text.trim(),
                  ...(researchable && research.on ? { research: true } : {}),
                  ...(mention.mentioned ? { personalityId: mention.mentioned.id } : {}),
                });
              }}
              inputRef={input}
              dictation={dictation}
              placeholder={`Message ${personality?.name ?? "Sling"}`}
              busy={send.isPending}
              canSend={Boolean(text.trim()) || files.sendable}
              above={
                <AttachmentChips
                  files={files}
                  leading={researchable && research.on && <ResearchChip onRemove={research.off} />}
                />
              }
              plus={{
                onAddFiles: files.pick,
                ...(researchable ? { research: research.option } : {}),
              }}
              onFiles={files.add}
              error={
                send.error ??
                followUp.error ??
                dictation.error ??
                setMode.error ??
                setSettings.error ??
                restore.error
              }
              overlay={<MentionList mention={mention} />}
              onKeyDown={mention.onKeyDown}
              controls={
                <ChatControls
                  catalog={catalog.data}
                  assistant={assistant}
                  onAssistant={(choice) => setSettings.mutate({ assistant: choice })}
                  // The mode only limits tools, so a personality without any has no use for it.
                  {...(hasTools ? { mode: conversation.mode, onMode: modeChange.change } : {})}
                />
              }
            />
          </div>
        </div>
      </div>
      {modeChange.dialog}
      {dropOverlay}
    </Page>
  );
}

/**
 * An assistant reply: its work in order, then the answer. The personality's
 * glyph marks it, and moves faster while the reply is being written.
 */
function AssistantRow({
  personality,
  name,
  active = false,
  children,
}: {
  personality: PersonalityView | null | undefined;
  /** Shown next to the glyph when it isn't the chat's own personality. */
  name?: string | undefined;
  active?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="group/reply flex gap-3">
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
      <div className="min-w-0 flex-1 space-y-2.5">
        {name && <p className="text-[13px] leading-6 font-medium">{name}</p>}
        {children}
      </div>
    </div>
  );
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const NOTE: Record<string, { text: string; tone: Tone }> = {
  succeeded: { text: "finished", tone: "ok" },
  failed: { text: "failed", tone: "danger" },
  cancelled: { text: "was cancelled", tone: "neutral" },
  rejected: { text: "was refused by the machine", tone: "danger" },
  interrupted: { text: "was interrupted", tone: "warn" },
};

const STEP_NAME: Record<string, string> = {
  push: "push",
  open_pr: "pull request",
  merge: "merge",
  deploy: "deploy",
  verify: "check",
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
  const failed = message.text.match(/^Delivery step (\w+): failed/m)?.[1];
  const note = waiting
    ? { text: "is waiting for your approval", tone: "warn" as Tone }
    : state === "succeeded" && failed
      ? { text: `finished, but its ${STEP_NAME[failed] ?? failed} failed`, tone: "danger" as Tone }
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
  personalities,
  latest,
  onSend,
}: {
  message: MessageView;
  activity: ActivityContext;
  tasks: Map<string, TaskView>;
  personality: PersonalityView | null | undefined;
  personalities: PersonalityView[] | undefined;
  /** The chat's last reply, with nothing being written after it. */
  latest: boolean;
  onSend: (text: string) => void;
}) {
  if (message.role === "system") return <SystemNote message={message} tasks={tasks} />;
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.attachments.length > 0 && <MessageFiles files={message.attachments} />}
        <UserBubble
          message={message}
          mentioned={personalities?.find((p) => p.id === message.personalityId)}
        />
      </div>
    );
  }
  const author = replyAuthor(message, personalities, personality);
  return (
    <AssistantRow personality={author} name={author !== personality ? author?.name : undefined}>
      {message.trace &&
        (message.trace.research ? (
          <ResearchSteps trace={message.trace} ctx={activity} />
        ) : (
          <ReplySteps steps={message.trace.steps} ctx={activity} />
        ))}
      <div className="prose-chat text-sm leading-6">
        <ChatMarkdown>{message.text}</ChatMarkdown>
      </div>
      <ReplySources message={message} />
      <ReplyActions message={message} latest={latest} />
      {latest && <FollowUps message={message} onSend={onSend} />}
    </AssistantRow>
  );
}
