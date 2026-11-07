import type { ChannelKind, ChannelView, RunnerView } from "@sling/core";
import { type LucideIcon, MessageCircle, MessageSquareLock } from "lucide-react";
import { plural } from "../lib/format.ts";
import { Badge, cx, Mono } from "./ui.tsx";

export const CHANNEL_ICON: Record<ChannelKind, LucideIcon> = {
  imessage: MessageCircle,
  signal: MessageSquareLock,
};

const LABEL: Record<ChannelKind, string> = { imessage: "iMessage", signal: "Signal" };

/**
 * The messaging channels a machine relays. Only the machine adds one or
 * allows its senders, so the list has nothing to change, only what each
 * still needs. Machines without channels show nothing.
 */
export function MachineChannels({ runner }: { runner: RunnerView }) {
  if (runner.channels.length === 0) return null;
  return (
    <section aria-label={`Channels on ${runner.name}`} className="border-t border-border">
      <div className="flex min-h-12 items-center gap-2 px-4 py-2">
        <span className="section-label">Channels</span>
        <span className="text-xs text-subtle tabular">{runner.channels.length}</span>
      </div>
      <ul aria-label={`Channel list for ${runner.name}`} className="border-t border-border">
        {runner.channels.map((c) => (
          <ChannelRow key={c.name} channel={c} online={runner.online} />
        ))}
      </ul>
    </section>
  );
}

function ChannelRow({ channel: c, online }: { channel: ChannelView; online: boolean }) {
  const Icon = CHANNEL_ICON[c.kind];
  const nobody = c.ready && c.allowedSenders === 0;
  return (
    <li className="flex min-h-[52px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0">
      <Icon
        aria-hidden="true"
        size={16}
        className={c.ready ? "shrink-0 text-icon" : "shrink-0 text-faint"}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          {LABEL[c.kind]}
          {c.name !== c.kind && <span className="ml-1.5 font-normal text-subtle">{c.name}</span>}
        </p>
        <p
          className={cx(
            "text-[11px] leading-4",
            c.ready ? "text-subtle" : "text-warn",
            !nobody && "truncate",
          )}
          title={c.ready ? undefined : c.missing}
        >
          {!c.ready ? (
            c.missing || "Not ready"
          ) : nobody ? (
            <>
              Answers no one yet. On this machine, run{" "}
              <Mono>sling-runner channel allow {c.name} &lt;number&gt;</Mono>
            </>
          ) : (
            `${plural(c.allowedSenders, "sender")} allowed`
          )}
        </p>
      </div>
      {online && (
        <Badge tone={c.ready ? "ok" : "warn"} dot={c.ready}>
          {c.ready ? "Ready" : "Not ready"}
        </Badge>
      )}
    </li>
  );
}
