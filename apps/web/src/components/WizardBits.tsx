import { ArrowUpRight, Check, CircleAlert, CircleCheck, Copy, Info } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.ts";
import { Button, cx, Spinner } from "./ui.tsx";

const TONE = {
  info: { icon: Info, className: "text-muted" },
  ok: { icon: CircleCheck, className: "text-ok" },
  warn: { icon: CircleAlert, className: "text-warn" },
  error: { icon: CircleAlert, className: "text-danger" },
} as const;

export type NoteTone = keyof typeof TONE | "wait";

/** One line of what Sling knows, under a step's fields: found, waiting, or wrong. */
export function StepNote({
  tone = "info",
  children,
  link,
}: {
  tone?: NoteTone;
  children: ReactNode;
  link?: { label: string; url: string };
}) {
  const { icon: Icon, className } = tone === "wait" ? TONE.info : TONE[tone];
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cx("flex items-start gap-1.5 text-xs leading-4", className)}
    >
      {tone === "wait" ? (
        <Spinner className="mt-px size-[13px] shrink-0" />
      ) : (
        <Icon aria-hidden="true" size={13} className="mt-px shrink-0" />
      )}
      <span className="min-w-0">
        {children}
        {link && (
          <>
            {" "}
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 whitespace-nowrap text-accent-text underline-offset-2 hover:underline"
            >
              {link.label}
              <ArrowUpRight aria-hidden="true" size={12} />
            </a>
          </>
        )}
      </span>
    </p>
  );
}

/** A command or URL to copy, in a field-like box. */
/**
 * A command that wraps between its words. A short word, such as a pairing
 * code, never breaks; a long one, such as a URL, breaks wherever it must.
 */
function Words({ text }: { text: string }) {
  return text.split(/(\s+)/).map((part, i) =>
    /^\s*$/.test(part) ? (
      part
    ) : (
      <span
        // A command's words have no identity of their own.
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        key={i}
        className={part.length > 24 ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"}
      >
        {part}
      </span>
    ),
  );
}

export function CopyLine({ text, label = "Copy" }: { text: string | undefined; label?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-field py-1 pr-1 pl-3 shadow-field">
      <pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-5 whitespace-pre-wrap text-soft">
        {text ? <Words text={text} /> : "…"}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        icon={copied === text && text ? Check : Copy}
        disabled={!text}
        onClick={async () => {
          if (text && (await copyText(text))) setCopied(text);
        }}
      >
        {copied === text && text ? "Copied" : label}
      </Button>
    </div>
  );
}

export interface CheckOption {
  value: string;
  label: ReactNode;
  /** A line under the label. */
  detail?: ReactNode;
  icon?: ReactNode;
  /** Shown checked and fixed, such as a repo that's already allowed. */
  locked?: boolean;
  /** Off and unchangeable, with the reason as its detail. */
  disabled?: boolean;
}

/**
 * Several of a list, as cards with a check each. The multi-pick sibling of
 * OptionCards: same size and spacing, a square box instead of a dot.
 */
export function CheckCards({
  label,
  options,
  value,
  onChange,
  columns = 1,
}: {
  label: string;
  options: CheckOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  columns?: 1 | 2;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const on = new Set(value);
  const toggle = (v: string) => {
    const next = new Set(on);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Keep the options' order, so what's sent doesn't depend on click order.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };
  const move = (from: number, by: number) => {
    refs.current[(from + by + options.length) % options.length]?.focus();
  };
  return (
    <fieldset
      aria-label={label}
      className={cx("grid min-w-0 gap-2", columns === 2 && "sm:grid-cols-2")}
    >
      {options.map((o, i) => {
        const checked = o.locked || on.has(o.value);
        const fixed = o.locked || o.disabled;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled checkboxes in a group.
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-disabled={fixed || undefined}
            onClick={() => !fixed && toggle(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cx(
              "flex min-w-0 items-start gap-3 rounded-xl p-3.5 text-left transition-shadow duration-150 focus-visible:shadow-focus focus-visible:outline-none",
              fixed ? "cursor-default" : "cursor-pointer",
              o.disabled && "opacity-60",
              checked && !o.locked
                ? "bg-surface-2 shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                : "bg-field shadow-field",
              !fixed && !checked && "hover:shadow-field-hover",
            )}
          >
            {o.icon && <span className="mt-0.5 shrink-0 text-icon">{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text">{o.label}</span>
              {o.detail && (
                <span className="mt-0.5 block text-xs leading-4 text-muted">{o.detail}</span>
              )}
            </span>
            <span
              aria-hidden="true"
              className={cx(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] transition-colors duration-150",
                checked
                  ? o.locked
                    ? "bg-surface-3 text-muted"
                    : "bg-accent text-white"
                  : "shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]",
              )}
            >
              {checked && <Check size={11} strokeWidth={3} />}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
