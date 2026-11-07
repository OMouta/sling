import type { MessageView, PersonalityView } from "@sling/core";
import { useMutation } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { MentionText } from "./MentionText.tsx";
import { Button, ErrorText } from "./ui.tsx";

const BUBBLE =
  "max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap shadow-active [overflow-wrap:anywhere]";

/**
 * The user's message. The latest one, when nothing since it did anything
 * outside the chat, has a pencil that turns it into a box to change it
 * and send it again.
 */
export function UserBubble({
  message,
  mentioned,
}: {
  message: MessageView;
  /** The personality the message @mentions, whose name shows in its color. */
  mentioned?: PersonalityView | undefined;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditBox message={message} onDone={() => setEditing(false)} />;
  return (
    <div className="group/user flex w-full items-center justify-end gap-1">
      {message.replaceable && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={Pencil}
          aria-label="Edit"
          title="Edit"
          onClick={() => setEditing(true)}
          className="opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        />
      )}
      <div className={BUBBLE}>
        <MentionText text={message.text} personality={mentioned} />
      </div>
    </div>
  );
}

function EditBox({ message, onDone }: { message: MessageView; onDone: () => void }) {
  const [text, setText] = useState(message.text);
  const input = useRef<HTMLTextAreaElement>(null);
  const send = useMutation({
    mutationFn: (value: string) =>
      api.post(`/api/conversations/${message.conversationId}/messages/${message.id}/edit`, {
        text: value,
      }),
    onSuccess: onDone,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: grow with the text.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  useEffect(() => {
    const el = input.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    const value = text.trim();
    if (value && !send.isPending) send.mutate(value);
  };
  return (
    <div className="w-full max-w-[85%] rounded-2xl bg-surface shadow-card has-[textarea:focus]:shadow-focus">
      <textarea
        ref={input}
        value={text}
        rows={1}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="block w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-sm leading-6 outline-none focus-visible:outline-none"
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        <div className="mr-auto min-w-0 pl-1.5">
          <ErrorText error={send.error} />
        </div>
        <Button size="sm" onClick={onDone} disabled={send.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={submit}
          busy={send.isPending}
          disabled={!text.trim()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
