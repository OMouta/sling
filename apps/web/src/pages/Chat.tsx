import type { AssistantChoice, ChatSettings, PermissionMode } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChatMarkdown } from "../components/ChatMarkdown.tsx";
import { useModeChange } from "../components/ConfirmFullAccess.tsx";
import { Logo } from "../components/Logo.tsx";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { ReplyTrace } from "../components/ReplyTrace.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { Badge, Button, cx, ErrorText, Skeleton } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { CHAT_WIDTH, useModelCatalog } from "../lib/models.ts";
import { useLiveReply } from "../lib/realtime.ts";
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

  const items = useMemo<Item[]>(() => {
    if (!detail.data) return [];
    const list: Item[] = [
      ...detail.data.messages.map((m) => ({
        kind: "message" as const,
        at: m.createdAt,
        message: m,
      })),
      ...detail.data.tasks.map((t) => ({ kind: "task" as const, at: t.createdAt, task: t })),
    ];
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [detail.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content grows.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items.length, live]);

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
  const thinking = agentStatus === "thinking";
  const tokens = usage.inputTokens + usage.outputTokens;

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (t && !send.isPending) send.mutate(t);
  }

  const assistant: AssistantChoice | null =
    conversation.settings?.assistant ?? catalog.data?.defaults.assistant ?? null;

  return (
    <Page
      title={conversation.title}
      badge={
        thinking ? (
          <Badge tone="accent" dot>
            Thinking
          </Badge>
        ) : undefined
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
          <div className={cx("mx-auto space-y-5", CHAT_WIDTH)}>
            {items.map((item) =>
              item.kind === "task" ? (
                <TaskCard key={item.task.id} task={item.task} />
              ) : (
                <Message key={item.message.id} message={item.message} />
              ),
            )}
            {thinking && (
              <AssistantRow
                trace={
                  <ReplyTrace steps={live?.steps ?? []} startedAt={live?.startedAt ?? openedAt} />
                }
              >
                {live?.text ? <ChatMarkdown>{live.text}</ChatMarkdown> : null}
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
                placeholder="Message Sling"
                className="block min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-5 outline-none placeholder:text-subtle focus-visible:outline-none"
              />
              <div className="flex items-center gap-2 px-2 pb-2">
                <ChatControls
                  className="min-w-0 flex-1"
                  catalog={catalog.data}
                  assistant={assistant}
                  onAssistant={(choice) => setSettings.mutate({ assistant: choice })}
                  mode={conversation.mode}
                  onMode={modeChange.change}
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

/** An assistant reply: how it got there, if shown, then the reply itself. */
function AssistantRow({
  trace,
  children,
}: {
  trace?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-accent text-white shadow-primary">
        <Logo className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {trace}
        {children && <div className="prose-chat text-sm leading-6">{children}</div>}
      </div>
    </div>
  );
}

function Message({ message }: { message: MessageView }) {
  if (message.role === "system") {
    const first = message.text.split("\n")[0] ?? "";
    return (
      <p className="text-center text-xs text-subtle" title={message.text}>
        {first}
      </p>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap shadow-active">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <AssistantRow
      trace={message.trace && <ReplyTrace steps={message.trace.steps} ms={message.trace.ms} />}
    >
      <ChatMarkdown>{message.text}</ChatMarkdown>
    </AssistantRow>
  );
}
