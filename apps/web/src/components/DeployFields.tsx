/** The parts of a site check that say how it deploys, and what it checks. */
import type { DeployMethod, DeployTargetView } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, Copy, Lock, Plus, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.ts";
import {
  blankCheck,
  DEFAULT_SETTLE,
  DEFAULT_TIMEOUT,
  type DraftErrors,
  type KnownRemote,
  MAX_CHECKS,
  repoNameFor,
  type TargetDraft,
} from "../lib/deploys.ts";
import { OptionCards } from "./SchemaForm.tsx";
import { Button, cx, Field, Input } from "./ui.tsx";

export const METHOD: Record<DeployMethod, { label: string; detail: string; short: string }> = {
  merge: {
    label: "When it's merged",
    detail:
      "Your host deploys main by itself: Vercel, Netlify, Railway, Render, Fly, Cloudflare Pages.",
    short: "On merge",
  },
  command: {
    label: "A command on one of your machines",
    detail: "Such as fly deploy or docker compose up, run on the merged commit.",
    short: "Command",
  },
  hook: {
    label: "A deploy hook",
    detail: "Your host gives you a URL to call: Render, Netlify, Vercel, Coolify and others.",
    short: "Deploy hook",
  },
};

/** "45 s", "10 min", "1 h". */
export function span(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600 || seconds % 3600 !== 0) {
    const m = seconds / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  }
  return `${seconds / 3600} h`;
}

/** "my-site" → "My site", for a name nobody has typed yet. */
export function nameFrom(repo: string): string {
  const words = repo.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** A field's problem, in place of its hint so the form doesn't grow a line. */
export function Problem({ text, fallback }: { text: string | undefined; fallback?: ReactNode }) {
  if (!text) return fallback ?? null;
  return <span className="text-danger">{text}</span>;
}

export function Disclosure({
  label,
  open: initial = false,
  children,
}: {
  label: string;
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted transition-colors duration-150 hover:text-text"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cx("transition-transform duration-150", open && "rotate-90")}
        />
        {label}
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}

/** One control per choice, in a pill. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <span className="block text-xs font-medium text-soft">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex w-fit max-w-full rounded-full bg-field p-0.5 shadow-field"
      >
        {options.map((o) => (
          // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              "h-[26px] cursor-pointer rounded-full px-3 text-xs whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
              value === o.value
                ? "bg-surface-3 text-text shadow-active"
                : "text-subtle enabled:hover:text-soft",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RepoChoice({
  remotes,
  taken,
  value,
  loading,
  onChange,
  none,
}: {
  remotes: KnownRemote[];
  taken: Map<string, string>;
  value: string;
  loading: boolean;
  onChange: (key: string) => void;
  /** An option that picks no repo, such as a site that only gets watched. */
  none?: { label: string; detail: string };
}) {
  if (loading) {
    return <div className="h-[68px] animate-pulse rounded-xl bg-field shadow-field" />;
  }
  const free = remotes.filter((r) => !taken.has(r.remoteKey) || r.remoteKey === value);
  if (free.length === 0 && !none) {
    return (
      <p className="text-[13px] leading-5 text-muted">
        {remotes.length === 0 ? (
          <>
            No repos yet. Pair a machine or allow a repo under{" "}
            <Link to="/machines" className="text-accent-text hover:underline">
              Machines
            </Link>
            .
          </>
        ) : (
          "Every repo already has a deploy target."
        )}
      </p>
    );
  }
  return (
    <OptionCards
      label="Repo"
      options={[
        ...(none ? [{ value: "", label: none.label, detail: none.detail }] : []),
        ...free.map((r) => ({
          value: r.remoteKey,
          label: repoNameFor(r, r.remoteKey),
          detail: r.onMachines.length
            ? `${r.remoteKey} · on ${[...new Set(r.onMachines.map((m) => m.runner.name))].join(", ")}`
            : `${r.remoteKey} · sandboxes`,
        })),
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

export function CodeLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-field py-1 pr-1 pl-3 shadow-field">
      <pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-soft">
        {text}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        icon={copied ? Check : Copy}
        onClick={async () => {
          if (await copyText(text)) setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function HookFields({
  draft,
  stored,
  editing,
  errors,
  set,
}: {
  draft: TargetDraft;
  stored: DeployTargetView["hook"];
  /** Filling in a hook, as opposed to keeping the stored one. */
  editing: boolean;
  errors: DraftErrors;
  set: <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => void;
}) {
  const url = useRef<HTMLInputElement>(null);
  const locked = !editing;
  return (
    <>
      {locked && stored ? (
        <span className="flex h-9 items-center gap-2 rounded-lg bg-field pr-1 pl-2.5 text-[13px] shadow-field">
          <Lock aria-hidden="true" size={13} className="shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate text-soft">Stored for {stored.host}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Replace the hook"
            onClick={() => {
              set("replaceHook", true);
              requestAnimationFrame(() => url.current?.focus());
            }}
          >
            Replace
          </Button>
        </span>
      ) : (
        <Field
          label="Hook URL"
          hint={
            draft.hookUrl.trim() && errors.hookUrl ? (
              <Problem text={errors.hookUrl} />
            ) : stored ? (
              <button
                type="button"
                className="cursor-pointer text-accent-text hover:underline"
                onClick={() => set("replaceHook", false)}
              >
                Keep the stored one
              </button>
            ) : (
              "Hidden once saved"
            )
          }
        >
          <Input
            ref={url}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft.hookUrl}
            placeholder="https://api.example-host.com/deploy/…"
            aria-invalid={Boolean(draft.hookUrl.trim() && errors.hookUrl)}
            onChange={(e) => set("hookUrl", e.target.value)}
          />
        </Field>
      )}
      <Disclosure label="More settings" open={Boolean(stored?.hasHeader)}>
        <Segmented
          label="Request"
          options={[
            { value: "POST" as const, label: "POST" },
            { value: "GET" as const, label: "GET" },
          ]}
          value={draft.httpMethod}
          disabled={locked}
          onChange={(m) => set("httpMethod", m)}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Header">
            <Input
              value={draft.headerName}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
              placeholder={locked ? (stored?.hasHeader ? "Stored" : "None") : "Authorization"}
              aria-invalid={Boolean(errors.header)}
              onChange={(e) => set("headerName", e.target.value)}
            />
          </Field>
          <Field label="Header value">
            <Input
              type="password"
              value={draft.headerValue}
              disabled={locked}
              autoComplete="off"
              placeholder={locked && stored?.hasHeader ? "Stored" : ""}
              aria-invalid={Boolean(errors.header)}
              onChange={(e) => set("headerValue", e.target.value)}
            />
          </Field>
        </div>
        {(errors.header || locked) && (
          <p className={cx("text-xs leading-4", errors.header ? "text-danger" : "text-subtle")}>
            {errors.header ?? "Replace the hook to change these."}
          </p>
        )}
      </Disclosure>
    </>
  );
}

export function ChecksFields({
  draft,
  shown,
  setDraft,
  open,
  extra,
}: {
  draft: TargetDraft;
  shown: (key: string, value: string) => string | undefined;
  setDraft: (fn: (d: TargetDraft) => TargetDraft) => void;
  open: boolean;
  /** More fields for its More settings, such as how often it runs. */
  extra?: ReactNode;
}) {
  const update = (i: number, patch: Partial<TargetDraft["checks"][number]>) =>
    setDraft((d) => ({
      ...d,
      checks: d.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <>
      <ol className="space-y-2" aria-label="Health checks">
        {draft.checks.map((c, i) => {
          const problem = shown(`check.${i}.url`, c.url);
          return (
            <li key={c.key}>
              <div className="flex items-center gap-2">
                <Input
                  type="url"
                  inputMode="url"
                  aria-label={i === 0 ? "URL to check" : `Check ${i + 1} URL`}
                  value={c.url}
                  placeholder="https://example.com"
                  aria-invalid={Boolean(problem)}
                  onChange={(e) => update(i, { url: e.target.value })}
                />
                {draft.checks.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={X}
                    aria-label={`Remove check ${i + 1}`}
                    onClick={() =>
                      setDraft((d) => ({ ...d, checks: d.checks.filter((_, j) => j !== i) }))
                    }
                  />
                )}
              </div>
              {problem && <p className="mt-1 text-xs leading-4 text-danger">{problem}</p>}
            </li>
          );
        })}
      </ol>
      {draft.checks.length < MAX_CHECKS && (
        <Button
          size="sm"
          variant="ghost"
          icon={Plus}
          className="-ml-1.5"
          onClick={() => setDraft((d) => ({ ...d, checks: [...d.checks, blankCheck()] }))}
        >
          Check another page
        </Button>
      )}
      <Disclosure label="More settings" open={open}>
        <Field
          label="Version URL"
          hint={
            <Problem
              text={shown("versionUrl", draft.versionUrl)}
              fallback="Waits until it shows the merged commit"
            />
          }
        >
          <Input
            type="url"
            inputMode="url"
            value={draft.versionUrl}
            placeholder="https://example.com/version"
            aria-invalid={Boolean(shown("versionUrl", draft.versionUrl))}
            onChange={(e) => set("versionUrl", e.target.value)}
          />
        </Field>
        {draft.checks.map((c, i) => (
          <div key={c.key} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
            <Field
              label={draft.checks.length > 1 ? `Status ${i + 1}` : "Status"}
              hint={<Problem text={shown(`check.${i}.status`, c.status)} />}
            >
              <Input
                inputMode="numeric"
                value={c.status}
                placeholder="200–399"
                aria-invalid={Boolean(shown(`check.${i}.status`, c.status))}
                onChange={(e) => update(i, { status: e.target.value.replace(/\D/g, "") })}
              />
            </Field>
            <Field label="Page contains">
              <Input
                value={c.contains}
                placeholder="Optional text"
                onChange={(e) => update(i, { contains: e.target.value })}
              />
            </Field>
          </div>
        ))}
        {extra}
      </Disclosure>
    </>
  );
}

/** How long a deploy's check waits before it starts, and how long it keeps going. */
export function TimingFields({
  draft,
  shown,
  setDraft,
}: {
  draft: TargetDraft;
  shown: (key: string, value: string) => string | undefined;
  setDraft: (fn: (d: TargetDraft) => TargetDraft) => void;
}) {
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field
        label="Wait before checking"
        hint={<Problem text={shown("settleSeconds", draft.settleSeconds)} fallback="Seconds" />}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={3600}
          value={draft.settleSeconds}
          placeholder={String(DEFAULT_SETTLE[draft.method])}
          aria-invalid={Boolean(shown("settleSeconds", draft.settleSeconds))}
          onChange={(e) => set("settleSeconds", e.target.value)}
        />
      </Field>
      <Field
        label="Keep checking for"
        hint={<Problem text={shown("timeoutSeconds", draft.timeoutSeconds)} fallback="Seconds" />}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={10}
          max={3600}
          value={draft.timeoutSeconds}
          placeholder={String(DEFAULT_TIMEOUT)}
          aria-invalid={Boolean(shown("timeoutSeconds", draft.timeoutSeconds))}
          onChange={(e) => set("timeoutSeconds", e.target.value)}
        />
      </Field>
    </div>
  );
}
