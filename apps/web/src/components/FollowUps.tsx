import type { MessageView } from "@sling/core";
import { CornerDownRight } from "lucide-react";

/** Messages the user might send next, under the latest reply. A tap sends one. */
export function FollowUps({
  message,
  onSend,
}: {
  message: MessageView;
  onSend: (text: string) => void;
}) {
  const followUps = message.trace?.followUps ?? [];
  if (followUps.length === 0) return null;
  return (
    <ul aria-label="Follow-ups" className="-ml-2 flex flex-col items-start gap-0.5">
      {followUps.map((text) => (
        <li key={text} className="max-w-full">
          <button
            type="button"
            onClick={() => onSend(text)}
            className="pressable flex max-w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-5 text-soft hover:bg-surface-3 hover:text-text"
          >
            <CornerDownRight
              aria-hidden="true"
              className="mt-[3px] size-3.5 shrink-0 text-subtle"
            />
            <span className="min-w-0">{text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
