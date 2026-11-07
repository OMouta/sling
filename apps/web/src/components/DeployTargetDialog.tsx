import {
  type DeployMethod,
  type DeployTargetView,
  MERGE_METHODS,
  type MergeMethod,
  type RunnerView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, Copy, Lock, Plus, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import {
  blankCheck,
  checkStatusText,
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
  shortUrl,
  type TargetDraft,
  upsertTarget,
  validateDraft,
} from "../lib/deploys.ts";
import { useSandboxRepos } from "../lib/sandboxApi.ts";
import { OptionCards } from "./SchemaForm.tsx";
import { Button, cx, Field, Input, Select } from "./ui.tsx";
import { type ReviewRow, Wizard, type WizardStep } from "./Wizard.tsx";

const METHOD: Record<DeployMethod, { label: string; detail: string; short: string }> = {
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
function span(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600 || seconds % 3600 !== 0) {
    const m = seconds / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  }
  return `${seconds / 3600} h`;
}

/** "my-site" → "My site", for a name nobody has typed yet. */
function nameFrom(repo: string): string {
  const words = repo.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** Add a deploy target, or change one, a step at a time. */
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
  const [draft, setDraft] = useState<TargetDraft>(() => draftFor(target));
  const [nameTyped, setNameTyped] = useState(target !== null);
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
    // While the command step waits on a machine to report its command, look again.
    refetchInterval: draft.method === "command" ? 4_000 : false,
  });
  const sandboxRepos = useSandboxRepos();
  const remotes = knownRemotes(runners.data ?? [], sandboxRepos.data ?? []);
  const taken = new Map(
    targets.filter((t) => t.id !== target?.id).map((t) => [t.remoteKey, t.name]),
  );
  const free = remotes.filter((r) => !taken.has(r.remoteKey));
  const loadingRepos = runners.isPending || sandboxRepos.isPending;

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
  const name = nameTyped ? draft.name : draft.name || nameFrom(repoNameFor(remote, remoteKey));
  const effective: TargetDraft = { ...draft, name, remoteKey, runnerId };
  const errors: DraftErrors = validateDraft(effective, { targets, editing: target });
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const has = (...keys: string[]) => keys.some((k) => errors[k]);
  // Errors show once there's something to be wrong about, not on an empty field.
  const shown = (key: string, value: string) => (value.trim() ? errors[key] : undefined);

  const [checked, setChecked] = useState<DeployTargetView | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const b = draftBody(effective, target);
      const saved = target ? await deployApi.update(target.id, b) : await deployApi.create(b);
      if (saved && typeof saved === "object" && "id" in saved) {
        upsertTarget(qc, saved);
        // A new target is checked straight away, so the done screen can say whether it's up.
        if (!target) {
          const after = await deployApi.check(saved.id).catch(() => saved);
          if (after && typeof after === "object" && "id" in after) {
            upsertTarget(qc, after);
            setChecked(after);
          }
        }
      }
      return saved;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: deployTargetsKey }),
  });

  // ---------------------------------------------------------------- steps
  const repoStep: WizardStep = {
    id: "repo",
    title: "Which repo is it?",
    blocked: has("remoteKey", "name"),
    content: (
      <>
        <RepoChoice
          remotes={remotes}
          taken={taken}
          value={remoteKey}
          loading={loadingRepos}
          onChange={(key) => setDraft((d) => ({ ...d, remoteKey: key, runnerId: "" }))}
        />
        {remoteKey && (
          <Field
            label="Name"
            hint={errors.name && name ? <Problem text={errors.name} /> : undefined}
          >
            <Input
              value={name}
              maxLength={60}
              placeholder="Website"
              aria-invalid={Boolean(errors.name && name)}
              onChange={(e) => {
                setNameTyped(true);
                set("name", e.target.value);
              }}
            />
          </Field>
        )}
      </>
    ),
  };

  const methodStep: WizardStep = {
    id: "method",
    title: "How does it go live?",
    content: (
      <>
        <OptionCards
          label="How it deploys"
          options={(["merge", "command", "hook"] as const).map((m) => ({
            value: m,
            label: METHOD[m].label,
            detail: METHOD[m].detail,
          }))}
          value={draft.method}
          onChange={(m) => set("method", m as DeployMethod)}
        />
        <Disclosure label="More settings" open={target !== null}>
          <Field label="Merge the PR with">
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
        </Disclosure>
      </>
    ),
  };

  const line = setCommandLine(repoNameFor(remote, remoteKey));
  const commandStep: WizardStep = {
    id: "command",
    title: "Which machine deploys it?",
    hint: machines.length === 0 ? "Set the command on the machine that deploys it:" : undefined,
    blocked: !runnerId,
    content:
      machines.length === 0 ? (
        <>
          <CodeLine text={line} />
          <p className="flex items-center gap-2 text-xs text-subtle">
            <span className="size-1.5 animate-pulse rounded-full bg-warn" aria-hidden="true" />
            Waiting for a machine to report it
          </p>
        </>
      ) : (
        <>
          <OptionCards
            label="Machine"
            options={machines.map((m) => ({
              value: m.runner.id,
              label: m.runner.name,
              detail: m.blocked
                ? `Refuses deploys: ${m.blocked}`
                : `Runs ${m.command}${m.runner.online ? "" : " · offline"}`,
            }))}
            value={runnerId}
            onChange={(id) => {
              const m = machines.find((x) => x.runner.id === id);
              if (m && !m.blocked) set("runnerId", id);
            }}
          />
          <Disclosure label="Deploy from another machine">
            <CodeLine text={line} />
          </Disclosure>
        </>
      ),
  };

  const hookStep: WizardStep = {
    id: "hook",
    title: "Paste the deploy hook",
    blocked: has("hookUrl", "header"),
    content: (
      <HookFields
        draft={draft}
        stored={target?.hook ?? null}
        editing={editsHook({ ...draft, method: "hook" }, target)}
        errors={errors}
        set={set}
      />
    ),
  };

  const checkKeys = draft.checks.flatMap((_, i) => [`check.${i}.url`, `check.${i}.status`]);
  const checksStep: WizardStep = {
    id: "checks",
    title: "Which page shows it's up?",
    blocked: has(...checkKeys, "versionUrl", "settleSeconds", "timeoutSeconds"),
    content: (
      <ChecksFields draft={draft} shown={shown} setDraft={setDraft} open={target !== null} />
    ),
  };

  const steps: WizardStep[] = [
    repoStep,
    methodStep,
    ...(draft.method === "command" ? [commandStep] : []),
    ...(draft.method === "hook" ? [hookStep] : []),
    checksStep,
  ];

  // ---------------------------------------------------------------- review, for editing
  const settle = Number(draft.settleSeconds) || DEFAULT_SETTLE[draft.method];
  const timeout = Number(draft.timeoutSeconds) || DEFAULT_TIMEOUT;
  const review: ReviewRow[] | undefined = target
    ? [
        { stepId: "repo", label: "Repo", value: remoteKey },
        { stepId: "repo", label: "Name", value: name },
        {
          stepId: "method",
          label: "Deploys",
          value: METHOD[draft.method].short,
        },
        ...(draft.method === "command"
          ? [
              {
                stepId: "command",
                label: "Machine",
                value: machines.find((m) => m.runner.id === runnerId)?.runner.name ?? "Not set",
              },
            ]
          : []),
        ...(draft.method === "hook"
          ? [
              {
                stepId: "hook",
                label: "Hook",
                value: editsHook(draft, target)
                  ? draft.hookUrl
                    ? "Changed"
                    : "Not set"
                  : `Stored for ${target.hook?.host ?? "the host"}`,
              },
            ]
          : []),
        { stepId: "method", label: "Merge with", value: MERGE_LABEL[draft.mergeMethod] },
        {
          stepId: "checks",
          label: "Checks",
          value: draft.checks.map((c) => shortUrl(c.url)).join(", "),
        },
        { stepId: "checks", label: "Version URL", value: draft.versionUrl || "None" },
        {
          stepId: "checks",
          label: "Timing",
          value: `Waits ${span(settle)}, checks for ${span(timeout)}`,
        },
      ]
    : undefined;

  const first = checked?.lastCheck?.results[0];
  return (
    <Wizard
      title={target ? `Edit ${target.name}` : "Add a deploy target"}
      steps={steps}
      finishLabel={target ? "Save" : "Add"}
      finishing={save.isPending}
      error={save.error instanceof Error ? save.error.message : null}
      onFinish={async () => {
        if (Object.keys(errors).length > 0) return false;
        try {
          await save.mutateAsync();
          return true;
        } catch {
          return false;
        }
      }}
      review={review}
      done={
        target ? undefined : (
          <>
            <p className="text-sm font-medium">{name} is set up</p>
            {checked?.lastCheck && first && (
              <p
                className={cx(
                  "mt-1 text-xs leading-4",
                  checked.lastCheck.up ? "text-muted" : "text-warn",
                )}
              >
                {checked.lastCheck.up
                  ? `${shortUrl(first.url)} answers ${checkStatusText(first)} in ${first.ms} ms`
                  : `${shortUrl(first.url)}: ${first.error ?? checkStatusText(first)}`}
              </p>
            )}
          </>
        )
      }
      onClose={onClose}
    />
  );
}

/** A field's problem, in place of its hint so the form doesn't grow a line. */
function Problem({ text, fallback }: { text: string | undefined; fallback?: ReactNode }) {
  if (!text) return fallback ?? null;
  return <span className="text-danger">{text}</span>;
}

function Disclosure({
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

function RepoChoice({
  remotes,
  taken,
  value,
  loading,
  onChange,
}: {
  remotes: KnownRemote[];
  taken: Map<string, string>;
  value: string;
  loading: boolean;
  onChange: (key: string) => void;
}) {
  if (loading) {
    return <div className="h-[68px] animate-pulse rounded-xl bg-field shadow-field" />;
  }
  const free = remotes.filter((r) => !taken.has(r.remoteKey) || r.remoteKey === value);
  if (free.length === 0) {
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
      options={free.map((r) => ({
        value: r.remoteKey,
        label: repoNameFor(r, r.remoteKey),
        detail: r.onMachines.length
          ? `${r.remoteKey} · on ${[...new Set(r.onMachines.map((m) => m.runner.name))].join(", ")}`
          : `${r.remoteKey} · sandboxes`,
      }))}
      value={value}
      onChange={onChange}
    />
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

function ChecksFields({
  draft,
  shown,
  setDraft,
  open,
}: {
  draft: TargetDraft;
  shown: (key: string, value: string) => string | undefined;
  setDraft: (fn: (d: TargetDraft) => TargetDraft) => void;
  open: boolean;
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
            hint={
              <Problem text={shown("timeoutSeconds", draft.timeoutSeconds)} fallback="Seconds" />
            }
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
      </Disclosure>
    </>
  );
}
