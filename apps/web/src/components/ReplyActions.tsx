import type { FeedbackRating, MessageView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  type LucideIcon,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { sendsOnEnter } from "../lib/keys.ts";
import { canSpeak, speak, stopIfSpeaking, stopSpeaking, useSpeaking } from "../lib/speech.ts";
import type { ConversationDetail } from "../lib/types.ts";
import { Button, cx, ErrorText, Textarea } from "./ui.tsx";

/** Sets a message's fields in its chat's cached copy. */
function usePatchMessage(message: MessageView) {
  const qc = useQueryClient();
  return (patch: Partial<MessageView>) =>
    qc.setQueryData<ConversationDetail>(["conversation", message.conversationId], (d) =>
      d
        ? { ...d, messages: d.messages.map((m) => (m.id === message.id ? { ...m, ...patch } : m)) }
        : d,
    );
}

function ActionButton({
  icon,
  label,
  onClick,
  pressed,
  busy,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      busy={busy}
      onClick={onClick}
      className={cx(pressed && "text-text [&_svg]:fill-current", className)}
    />
  );
}

/**
 * What can be done with a reply: copy it, read it aloud, rate it, retry it.
 * Always there under the latest reply and on touch screens; under older
 * ones it shows on hover. Its height is kept either way, so nothing moves.
 */
export function ReplyActions({ message, latest }: { message: MessageView; latest: boolean }) {
  const qc = useQueryClient();
  const patch = usePatchMessage(message);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const speaking = useSpeaking(message.id);
  const downThumb = useRef<HTMLSpanElement>(null);
  const id = message.id;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(t);
  }, [copied]);
  // Leaving the chat, or the reply going away, stops it being read.
  useEffect(() => () => stopIfSpeaking(id), [id]);

  const rate = useMutation({
    mutationFn: (next: { rating: FeedbackRating | null; reason?: string }) =>
      next.rating
        ? api.put(`/api/messages/${id}/feedback`, {
            rating: next.rating,
            ...(next.reason ? { reason: next.reason } : {}),
          })
        : api.del(`/api/messages/${id}/feedback`),
    onMutate: (next) => {
      const before = message.feedback;
      patch({ feedback: next.rating });
      return { before };
    },
    onError: (_err, _next, saved) => patch({ feedback: saved?.before ?? null }),
  });
  const retry = useMutation({
    mutationFn: () =>
      api.post(`/api/conversations/${message.conversationId}/retry`, { messageId: id }),
    onError: () => qc.invalidateQueries({ queryKey: ["conversation", message.conversationId] }),
  });

  const thumb = (rating: FeedbackRating) => {
    // The same one again takes it back.
    if (message.feedback === rating) {
      setAsking(false);
      rate.mutate({ rating: null });
      return;
    }
    rate.mutate({ rating });
    setAsking(rating === "down");
  };

  return (
    <div>
      <div
        className={cx(
          "relative -ml-1.5 flex items-center gap-0.5 transition-opacity duration-150",
          !latest &&
            !asking &&
            !speaking &&
            "opacity-0 group-hover/reply:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <ActionButton
          icon={copied ? Check : Copy}
          label={copied ? "Copied" : "Copy"}
          onClick={async () => {
            if (await copyText(message.text)) setCopied(true);
          }}
        />
        {canSpeak() && (
          <ActionButton
            icon={speaking ? Square : Volume2}
            label={speaking ? "Stop reading" : "Read aloud"}
            pressed={speaking}
            onClick={() => (speaking ? stopSpeaking() : speak(id, message.text))}
          />
        )}
        <ActionButton
          icon={ThumbsUp}
          label="Good reply"
          pressed={message.feedback === "up"}
          onClick={() => thumb("up")}
        />
        <span ref={downThumb} className="contents">
          <ActionButton
            icon={ThumbsDown}
            label="Bad reply"
            pressed={message.feedback === "down"}
            onClick={() => thumb("down")}
          />
        </span>
        {asking && (
          <ReasonPopover
            thumb={downThumb}
            onClose={() => setAsking(false)}
            onSend={(reason) => {
              setAsking(false);
              if (reason) rate.mutate({ rating: "down", reason });
            }}
          />
        )}
        {latest && message.replaceable && (
          <ActionButton
            icon={RotateCcw}
            label="Retry"
            busy={retry.isPending}
            onClick={() => retry.mutate()}
          />
        )}
      </div>
      {(retry.error || rate.error) && (
        <div className="mt-1">
          <ErrorText error={retry.error ?? rate.error} />
        </div>
      )}
    </div>
  );
}

/** Asks why a reply was bad. Optional: the thumbs down already counts. */
function ReasonPopover({
  thumb,
  onSend,
  onClose,
}: {
  /** The thumb that opened it, which toggles it itself. */
  thumb: RefObject<HTMLElement | null>;
  onSend: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !thumb.current?.contains(target)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector("textarea")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [thumb]);
  const send = () => onSend(reason.trim());
  return (
    <div
      ref={root}
      role="dialog"
      aria-label="What was wrong with it?"
      className="anim-pop absolute bottom-full left-0 z-40 mb-1.5 w-72 max-w-full rounded-xl bg-surface p-2 shadow-popover"
      style={{ transformOrigin: "bottom left" }}
    >
      <Textarea
        value={reason}
        rows={3}
        maxLength={500}
        placeholder="What was wrong with it?"
        aria-label="What was wrong with it?"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (sendsOnEnter(e)) {
            e.preventDefault();
            send();
          }
        }}
        className="resize-none"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="primary" onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}
