import { MODE_POLICY, PERMISSION_MODES, type PermissionMode } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { TaskCard } from "../components/TaskCard.tsx";
import { Button, cx, ErrorText, Select, Spinner, Textarea } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useStreamingText } from "../lib/realtime.ts";
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
  const streamText = useStreamingText(id);
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post(`/api/conversations/${id}/messages`, { text: message }),
    onSuccess: () => setText(""),
  });
  const setMode = useMutation({
    mutationFn: (mode: PermissionMode) => api.patch(`/api/conversations/${id}`, { mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", id] }),
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
  }, [items.length, streamText]);

  if (detail.isPending) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-6">
        <ErrorText error={detail.error ?? "Conversation not found."} />
      </div>
    );
  }

  const { conversation, agentStatus, usage } = detail.data;
  const thinking = agentStatus === "thinking";

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (t && !send.isPending) send.mutate(t);
  }

  function changeMode(mode: PermissionMode) {
    if (
      mode === "full-access" &&
      !window.confirm(
        "Full access runs Codex without a sandbox and skips every approval, including pushes. Use it only for repos and machines you trust. Switch?",
      )
    ) {
      return;
    }
    setMode.mutate(mode);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate font-medium">{conversation.title}</h1>
        {usage.inputTokens + usage.outputTokens > 0 && (
          <span className="hidden text-xs text-muted sm:inline">
            {(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens
          </span>
        )}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Mode</span>
          <Select
            value={conversation.mode}
            onChange={(e) => changeMode(e.target.value as PermissionMode)}
            className="h-8 w-auto py-0 pr-8"
            aria-label="Permission mode"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_POLICY[m].label}
              </option>
            ))}
          </Select>
        </div>
      </header>
      {conversation.mode === "full-access" && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
          Full access: Codex runs without a sandbox and nothing asks before pushing.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
          {items.length === 0 && (
            <p className="py-10 text-center text-sm text-muted">
              {MODE_POLICY[conversation.mode].label} mode.{" "}
              {MODE_POLICY[conversation.mode].description}
            </p>
          )}
          {items.map((item) =>
            item.kind === "task" ? (
              <TaskCard key={item.task.id} task={item.task} />
            ) : (
              <Message key={item.message.id} message={item.message} />
            ),
          )}
          {thinking && (
            <div className="flex gap-3">
              <div className="prose-chat min-w-0 flex-1 text-[15px] leading-relaxed">
                {streamText ? (
                  <Markdown>{streamText}</Markdown>
                ) : (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <Spinner className="size-3.5" /> Thinking
                  </span>
                )}
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <form onSubmit={submit} className="border-t border-border bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) submit(e);
            }}
            placeholder="Message Sling"
            className="max-h-48 min-h-10 resize-none"
          />
          <Button type="submit" variant="primary" busy={send.isPending} disabled={!text.trim()}>
            Send
          </Button>
        </div>
        <div className="mx-auto max-w-3xl">
          <ErrorText error={send.error ?? setMode.error} />
        </div>
      </form>
    </div>
  );
}

function Message({ message }: { message: MessageView }) {
  if (message.role === "system") {
    const first = message.text.split("\n")[0] ?? "";
    return (
      <p className="text-center text-xs text-muted" title={message.text}>
        {first}
      </p>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-accent-fg">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className={cx("prose-chat text-[15px] leading-relaxed")}>
      <Markdown>{message.text}</Markdown>
    </div>
  );
}
