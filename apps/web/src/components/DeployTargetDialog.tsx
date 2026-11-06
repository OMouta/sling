import {
  DEPLOY_METHODS,
  type DeployMethod,
  type DeployTargetView,
  MERGE_METHODS,
  type MergeMethod,
  type RunnerView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Lock, Plus, X } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import {
  blankCheck,
  DEFAULT_SETTLE,
  DEFAULT_TIMEOUT,
  type DraftErrors,
  deployApi,
  deployMachines,
  deployTargetsKey,
  draftBody,
  draftFor,
  editsHook,
  type KnownRemote,
  knownRemotes,
  MAX_CHECKS,
  MERGE_LABEL,
  repoNameFor,
  setCommandLine,
  type TargetDraft,
  upsertTarget,
  validateDraft,
} from "../lib/deploys.ts";
import { useSandboxRepos } from "../lib/sandboxApi.ts";
import { Button, cx, Dialog, ErrorText, Field, Input, Mono, Select } from "./ui.tsx";

const METHOD_LABEL: Record<DeployMethod, string> = {
  merge: "On merge",
  command: "Command",
  hook: "Deploy hook",
};

/** "45 s", "10 min", "1 h". */
function span(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600 || seconds % 3600 !== 0) {
    const m = seconds / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  }
  return `${seconds / 3600} h`;
}

/** Add a deploy target, or change one. */
export function DeployTargetDialog({
  target,
  targets,
  onClose,
}: {
  /** The target to edit, or null to add one. */
  target: DeployTargetView | null;
  targets: DeployTargetView[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  const sandboxRepos = useSandboxRepos();
  const remotes = knownRemotes(runners.data ?? [], sandboxRepos.data ?? []);
  const taken = new Map(
    targets.filter((t) => t.id !== target?.id).map((t) => [t.remoteKey, t.name]),
  );

  const [draft, setDraft] = useState<TargetDraft>(() => draftFor(target));
  const [tried, setTried] = useState(false);
  const [timingOpen, setTimingOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // Until the lists load, a lone free repo can't be picked for you; once they have, it is.
  const free = remotes.filter((r) => !taken.has(r.remoteKey));
  const remoteKey =
    draft.remoteKey || (!target && free.length === 1 ? (free[0]?.remoteKey ?? "") : "");
  const remote = remotes.find((r) => r.remoteKey === remoteKey);
  const machines = deployMachines(remote);
  const usable = machines.filter((m) => !m.blocked);
  const runnerId =
    draft.runnerId && machines.some((m) => m.runner.id === draft.runnerId)
      ? draft.runnerId
      : usable.length === 1
        ? (usable[0]?.runner.id ?? "")
        : "";
  const effective: TargetDraft = { ...draft, remoteKey, runnerId };

  const errors: DraftErrors = tried ? validateDraft(effective, { targets, editing: target }) : {};
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const b = draftBody(effective, target);
      return target ? deployApi.update(target.id, b) : deployApi.create(b);
    },
    onSuccess: (saved) => {
      if (saved && typeof saved === "object" && "id" in saved) upsertTarget(qc, saved);
      void qc.invalidateQueries({ queryKey: deployTargetsKey });
      onClose();
    },
  });

  const submit = () => {
    setTried(true);
    const found = validateDraft(effective, { targets, editing: target });
    if (Object.keys(found).length === 0) {
      save.mutate();
      return;
    }
    if (found.settleSeconds || found.timeoutSeconds) setTimingOpen(true);
    // After the errors render, put the cursor in the first field that has one.
    requestAnimationFrame(() =>
      body.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus(),
    );
  };

  // What the Timing summary says, so a typed 0 reads as 0 and a blank as the default.
  const entered = (text: string, fallback: number) => {
    const n = Number(text);
    return text.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const settle = entered(draft.settleSeconds, DEFAULT_SETTLE[draft.method]);
  const timeout = entered(draft.timeoutSeconds, DEFAULT_TIMEOUT);

  return (
    <Dialog
      title={target ? `Edit ${target.name}` : "Add a deploy target"}
      description="A repo Sling can merge, deploy, and check once a fix is approved."
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto min-w-0">
            <ErrorText error={save.error} />
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {target ? "Save" : "Add target"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div ref={body} className="space-y-5">
          <Field label="Name" hint={errors.name && <Problem text={errors.name} />}>
            <Input
              value={draft.name}
              maxLength={60}
              placeholder="Website"
              aria-invalid={Boolean(errors.name)}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>

          <RepoPicker
            remotes={remotes}
            taken={taken}
            value={remoteKey}
            loading={runners.isPending || sandboxRepos.isPending}
            error={errors.remoteKey}
            onChange={(key) => setDraft((d) => ({ ...d, remoteKey: key, runnerId: "" }))}
          />

          <div className="space-y-3">
            <Segmented
              label="How it deploys"
              options={DEPLOY_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
              value={draft.method}
              onChange={(m) => set("method", m)}
            />
            {/* Every method's fields share one cell, so the dialog keeps its height as you switch. */}
            <div className="grid">
              <MethodPanel active={draft.method === "merge"}>
                <div className="space-y-2 text-xs leading-[18px] text-muted">
                  <p>
                    Your host deploys the default branch when it changes, as Vercel, Netlify, and
                    Render do. Sling merges, waits {span(settle)}, then runs the checks.
                  </p>
                  <p>
                    The host decides when the new version goes live, so add a version URL below.
                    Then Sling waits until the site shows the merged commit, instead of passing on
                    the old version.
                  </p>
                </div>
              </MethodPanel>
              <MethodPanel active={draft.method === "command"}>
                <CommandFields
                  remote={remote}
                  remoteKey={remoteKey}
                  machines={machines}
                  value={runnerId}
                  error={errors.runnerId}
                  onChange={(id) => set("runnerId", id)}
                />
              </MethodPanel>
              <MethodPanel active={draft.method === "hook"}>
                <HookFields
                  draft={draft}
                  stored={target?.hook ?? null}
                  editing={editsHook({ ...draft, method: "hook" }, target)}
                  errors={errors}
                  set={set}
                />
              </MethodPanel>
            </div>
          </div>

          <ChecksFields draft={draft} errors={errors} setDraft={setDraft} />

          <Field
            label="Version URL (optional)"
            hint={
              errors.versionUrl ? (
                <Problem text={errors.versionUrl} />
              ) : (
                "A URL whose page shows the deployed commit. Without one, Sling can't tell which version answered."
              )
            }
          >
            <Input
              type="url"
              inputMode="url"
              value={draft.versionUrl}
              placeholder="https://example.com/version"
              aria-invalid={Boolean(errors.versionUrl)}
              onChange={(e) => set("versionUrl", e.target.value)}
            />
          </Field>

          <Field label="Merge with">
            <Select
              value={draft.mergeMethod}
              onChange={(e) => set("mergeMethod", e.target.value as MergeMethod)}
            >
              {MERGE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {MERGE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>

          <details
            open={timingOpen}
            onToggle={(e) => setTimingOpen(e.currentTarget.open)}
            className="rounded-lg bg-surface-2 px-3 py-2 shadow-raised"
          >
            <summary className="cursor-pointer text-xs font-medium text-soft select-none marker:text-subtle">
              Timing{" "}
              <span className="font-normal text-subtle">
                · waits {span(settle)}, then checks for up to {span(timeout)}
              </span>
            </summary>
            <div className="mt-3 grid gap-3 pb-1 sm:grid-cols-2">
              <Field
                label="Wait before the first check"
                hint={<Problem text={errors.settleSeconds} fallback="Seconds" />}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={3600}
                  value={draft.settleSeconds}
                  placeholder={String(DEFAULT_SETTLE[draft.method])}
                  aria-invalid={Boolean(errors.settleSeconds)}
                  onChange={(e) => set("settleSeconds", e.target.value)}
                />
              </Field>
              <Field
                label="Keep checking for"
                hint={<Problem text={errors.timeoutSeconds} fallback="Seconds, up to 3,600" />}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={10}
                  max={3600}
                  value={draft.timeoutSeconds}
                  placeholder={String(DEFAULT_TIMEOUT)}
                  aria-invalid={Boolean(errors.timeoutSeconds)}
                  onChange={(e) => set("timeoutSeconds", e.target.value)}
                />
              </Field>
            </div>
          </details>
        </div>
        {/* Enter in a field submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** A field's problem, in place of its hint so the form doesn't grow a line. */
function Problem({ text, fallback }: { text: string | undefined; fallback?: ReactNode }) {
  if (!text) return fallback ?? null;
  return <span className="text-danger">{text}</span>;
}

function MethodPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active || undefined}
      inert={!active}
      className={cx("[grid-area:1/1]", !active && "invisible")}
    >
      {children}
    </div>
  );
}

/** One control per choice, in a pill. */
function Segmented<T extends string>({
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
  const id = useId();
  return (
    <div className={cx("space-y-1.5", className)}>
      <span id={id} className="block text-xs font-medium text-soft">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={id}
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

function RepoPicker({
  remotes,
  taken,
  value,
  loading,
  error,
  onChange,
}: {
  remotes: KnownRemote[];
  taken: Map<string, string>;
  value: string;
  loading: boolean;
  error: string | undefined;
  onChange: (key: string) => void;
}) {
  const none = !loading && remotes.length === 0;
  const r = remotes.find((x) => x.remoteKey === value);
  const where = r
    ? r.onMachines.length
      ? `On ${[...new Set(r.onMachines.map((m) => m.runner.name))].join(", ")}`
      : "On the sandbox list"
    : null;
  return (
    <Field
      label="Repo"
      hint={
        error ? (
          <Problem text={error} />
        ) : none ? (
          <>
            Sling knows a repo once a machine allows it. Add one under{" "}
            <Link to="/machines" className="text-accent-text hover:underline">
              Machines
            </Link>
            .
          </>
        ) : (
          (where ?? "Repos with a remote, from your machines and the sandbox list.")
        )
      }
    >
      <Select
        value={value}
        disabled={none}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {loading ? "Loading repos…" : none ? "No repos yet" : "Pick a repo"}
        </option>
        {remotes.map((x) => (
          <option key={x.remoteKey} value={x.remoteKey} disabled={taken.has(x.remoteKey)}>
            {x.remoteKey}
            {taken.has(x.remoteKey) ? ` (${taken.get(x.remoteKey)} deploys it)` : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function CommandFields({
  remote,
  remoteKey,
  machines,
  value,
  error,
  onChange,
}: {
  remote: KnownRemote | undefined;
  remoteKey: string;
  machines: ReturnType<typeof deployMachines>;
  value: string;
  error: string | undefined;
  onChange: (runnerId: string) => void;
}) {
  if (!remoteKey) {
    // The same shape as once a repo is picked, so nothing jumps when it is.
    return (
      <Field
        label="Machine"
        hint="The deploy command lives on the machine, so Sling picks where it runs but never what runs."
      >
        <Select value="" disabled onChange={() => {}}>
          <option value="">Pick a repo first</option>
        </Select>
      </Field>
    );
  }
  const line = setCommandLine(repoNameFor(remote, remoteKey));
  if (machines.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs leading-[18px] text-muted">
          No machine has a deploy command for this repo. The command lives on the machine, so Sling
          can pick where it runs but never what runs. Set it on the machine that deploys:
        </p>
        <CodeLine text={line} />
        <p className={cx("text-xs leading-4", error ? "text-danger" : "text-subtle")}>
          {error ?? "It shows up here once the machine reports it."}
        </p>
      </div>
    );
  }
  const picked = machines.find((m) => m.runner.id === value);
  return (
    <div className="space-y-3">
      <Field
        label="Machine"
        hint={
          error ? (
            <Problem text={error} />
          ) : picked ? (
            <>
              Runs <Mono>{picked.command}</Mono> in a fresh checkout of the merged commit.
            </>
          ) : (
            "Only machines with a deploy command for this repo are listed."
          )
        }
      >
        <Select
          value={value}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>
            Pick a machine
          </option>
          {machines.map((m) => (
            <option key={m.runner.id} value={m.runner.id} disabled={m.blocked !== null}>
              {m.runner.name}: {m.command}
              {m.blocked ? ` (${m.blocked})` : m.runner.online ? "" : " (offline)"}
            </option>
          ))}
        </Select>
      </Field>
      <div className="space-y-1.5">
        <p className="text-xs leading-4 text-subtle">
          To deploy from another machine, set its command:
        </p>
        <CodeLine text={line} />
      </div>
    </div>
  );
}

function CodeLine({ text }: { text: string }) {
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
          await navigator.clipboard.writeText(text);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function HookFields({
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
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        {locked && stored ? (
          // Not a label: the stored URL can't be edited, only replaced.
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-soft">Hook URL</span>
            <span className="flex h-8 items-center gap-2 rounded-lg bg-field pr-1 pl-2.5 text-[13px] shadow-field">
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
            <span className="block text-xs leading-4 text-subtle">
              Stored encrypted. Sling never shows it again.
            </span>
          </div>
        ) : (
          <Field
            label="Hook URL"
            hint={
              errors.hookUrl ? (
                <Problem text={errors.hookUrl} />
              ) : stored ? (
                <>
                  Replaces the stored one when you save.{" "}
                  <button
                    type="button"
                    className="cursor-pointer text-accent-text hover:underline"
                    onClick={() => set("replaceHook", false)}
                  >
                    Keep the stored one
                  </button>
                </>
              ) : (
                "Stored encrypted. Sling never shows it again."
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
              aria-invalid={Boolean(errors.hookUrl)}
              onChange={(e) => set("hookUrl", e.target.value)}
            />
          </Field>
        )}
        <Segmented
          label="Request"
          className="sm:self-end sm:pb-[23px]"
          options={[
            { value: "POST" as const, label: "POST" },
            { value: "GET" as const, label: "GET" },
          ]}
          value={draft.httpMethod}
          disabled={locked}
          onChange={(m) => set("httpMethod", m)}
        />
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Header (optional)">
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
        <p className={cx("text-xs leading-4", errors.header ? "text-danger" : "text-subtle")}>
          {errors.header ??
            (locked ? "Replace the hook to change these." : "Sent with each call, write-only.")}
        </p>
      </div>
    </div>
  );
}

function ChecksFields({
  draft,
  errors,
  setDraft,
}: {
  draft: TargetDraft;
  errors: DraftErrors;
  setDraft: (fn: (d: TargetDraft) => TargetDraft) => void;
}) {
  const update = (i: number, patch: Partial<TargetDraft["checks"][number]>) =>
    setDraft((d) => ({
      ...d,
      checks: d.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  const cols =
    "grid grid-cols-[84px_minmax(0,1fr)_26px] gap-2 sm:grid-cols-[minmax(0,1.4fr)_84px_minmax(0,1fr)_26px]";
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 block text-xs font-medium text-soft">Health checks</legend>
      <p className="-mt-0.5 text-xs leading-4 text-subtle">
        Sling GETs each one. Any status from 200 to 399 passes unless you set one.
      </p>
      <div aria-hidden="true" className={cx(cols, "text-xs text-subtle max-sm:hidden")}>
        <span>URL</span>
        <span>Status</span>
        <span>Page contains</span>
      </div>
      <ol className="space-y-2">
        {draft.checks.map((c, i) => {
          const urlError = errors[`check.${i}.url`];
          const statusError = errors[`check.${i}.status`];
          const n = i + 1;
          return (
            <li key={c.key}>
              <div className={cols}>
                <Input
                  type="url"
                  inputMode="url"
                  aria-label={`Check ${n} URL`}
                  className="max-sm:col-span-3"
                  value={c.url}
                  placeholder="https://example.com/health"
                  aria-invalid={Boolean(urlError)}
                  onChange={(e) => update(i, { url: e.target.value })}
                />
                <Input
                  inputMode="numeric"
                  aria-label={`Check ${n} status`}
                  value={c.status}
                  placeholder="200–399"
                  aria-invalid={Boolean(statusError)}
                  onChange={(e) => update(i, { status: e.target.value.replace(/\D/g, "") })}
                />
                <Input
                  aria-label={`Check ${n} page contains`}
                  value={c.contains}
                  placeholder="Optional text"
                  onChange={(e) => update(i, { contains: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={X}
                  className="self-center"
                  aria-label={`Remove check ${n}`}
                  disabled={draft.checks.length === 1}
                  onClick={() =>
                    setDraft((d) => ({ ...d, checks: d.checks.filter((_, j) => j !== i) }))
                  }
                />
              </div>
              {(urlError || statusError) && (
                <p className="mt-1 text-xs leading-4 text-danger">{urlError ?? statusError}</p>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          icon={Plus}
          disabled={draft.checks.length >= MAX_CHECKS}
          onClick={() => setDraft((d) => ({ ...d, checks: [...d.checks, blankCheck()] }))}
        >
          Add check
        </Button>
        <span className="text-xs text-subtle">Up to {MAX_CHECKS}</span>
      </div>
    </fieldset>
  );
}
