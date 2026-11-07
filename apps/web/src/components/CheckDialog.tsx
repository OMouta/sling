import {
  CHECK_INTERVAL_SECONDS,
  type CheckConfig,
  type CheckDeployInput,
  type CheckInput,
  type CheckKind,
  type CheckView,
  type DeployMethod,
  type DeployTargetView,
  MERGE_METHODS,
  type MergeMethod,
  type RunnerView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { checkApi, checksKey, deadlineText, everyText, upsertCheck } from "../lib/checks.ts";
import {
  blankCheck,
  DEFAULT_SETTLE,
  DEFAULT_TIMEOUT,
  type DraftErrors,
  deployMachines,
  deployTargetsKey,
  draftBody,
  draftFor,
  editsHook,
  knownRemotes,
  MERGE_LABEL,
  repoNameFor,
  setCommandLine,
  shortUrl,
  type TargetDraft,
  validateDraft,
} from "../lib/deploys.ts";
import { machinesOnly } from "../lib/machines.ts";
import { useSandboxRepos } from "../lib/sandboxApi.ts";
import { useInstallations } from "../lib/workflowApi.ts";
import {
  ChecksFields,
  CodeLine,
  Disclosure,
  HookFields,
  METHOD,
  nameFrom,
  Problem,
  RepoChoice,
  span,
  TimingFields,
} from "./DeployFields.tsx";
import { OptionCards } from "./SchemaForm.tsx";
import { Field, Input, Select, Switch } from "./ui.tsx";
import { type ReviewRow, Wizard, type WizardStep } from "./Wizard.tsx";

const KINDS: Record<CheckKind, { label: string; detail: string }> = {
  site: { label: "A site", detail: "Its pages answer, checked every minute. It can also deploy." },
  command: {
    label: "A command on a machine",
    detail: "Exits 0 in the machine's read-only sandbox, every 5 minutes.",
  },
  reply: { label: "An email reply", detail: "Arrives before a deadline you set." },
};

const EVERY = [30, 60, 300, 900, 3600, 6 * 3600, 86400];

/** "2026-11-13T17:00" for a datetime-local input, in the browser's zone. */
function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The name a site check gets from its first URL until one is typed. */
function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host ? host.charAt(0).toUpperCase() + host.slice(1) : "";
  } catch {
    return "";
  }
}

/** The site part of the form: the deploy target's, or just the check's URLs. */
function siteDraft(
  target: DeployTargetView | null,
  config: Extract<CheckConfig, { kind: "site" }> | null,
): TargetDraft {
  const d = draftFor(target);
  if (target || !config) return d;
  return {
    ...d,
    checks: config.checks.map((c) => ({
      ...blankCheck(),
      url: c.url,
      status: c.status === null ? "" : String(c.status),
      contains: c.contains ?? "",
    })),
    versionUrl: config.versionUrl ?? "",
  };
}

/** A shell that can't sandbox, or has commands off, can't take a check. */
function commandBlocked(r: RunnerView): string | null {
  const shell = r.capabilities.find((c) => c.name === "shell");
  if (!shell) return "too old to run commands";
  if (!shell.ready) return "commands are off";
  const sandbox = r.capabilities.find((c) => c.name === "shell.sandbox");
  if (!sandbox?.ready) return "can't sandbox commands";
  return null;
}

/** Add a check, or change one, a step at a time. A site's deploy is part of it. */
export function CheckDialog({
  check,
  checks,
  onClose,
}: {
  /** The check to edit, or null to add one. */
  check: CheckView | null;
  checks: CheckView[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const siteConfig = check?.config.kind === "site" ? check.config : null;
  // The deploy section is a deploy target, as the form for one takes it.
  const target: DeployTargetView | null =
    check?.deploy && siteConfig
      ? {
          ...check.deploy,
          name: check.name,
          checks: siteConfig.checks,
          versionUrl: siteConfig.versionUrl,
          lastCheck: null,
          createdAt: check.createdAt,
          updatedAt: check.updatedAt,
        }
      : null;
  // Other sites that deploy, so a repo deploys from one check only.
  const targets: DeployTargetView[] = checks.flatMap((c) =>
    c.deploy && c.config.kind === "site" && c.id !== check?.id
      ? [
          {
            ...c.deploy,
            name: c.name,
            checks: c.config.checks,
            versionUrl: c.config.versionUrl,
            lastCheck: null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          },
        ]
      : [],
  );
  const [kind, setKind] = useState<CheckKind>(check?.kind ?? "site");
  const [nameTyped, setNameTyped] = useState(check !== null);
  const [name, setName] = useState(check?.name ?? "");
  const [draft, setDraft] = useState<TargetDraft>(() => siteDraft(target, siteConfig));
  const cmd = check?.config.kind === "command" ? check.config : null;
  const [command, setCommand] = useState(cmd?.command ?? "");
  const [contains, setContains] = useState(cmd?.contains ?? "");
  const [timeout, setTimeoutText] = useState(String(cmd?.timeoutSeconds ?? 60));
  const [runnerId, setRunnerId] = useState(check?.runnerId ?? "");
  const reply = check?.config.kind === "reply" ? check.config : null;
  const [from, setFrom] = useState(reply?.from ?? "");
  const [subject, setSubject] = useState(reply?.subject ?? "");
  const [installationId, setInstallationId] = useState(check?.installationId ?? "");
  const [deadline, setDeadline] = useState(localInput(check?.deadline ?? null));
  const [interval, setIntervalSeconds] = useState(
    check?.intervalSeconds ?? CHECK_INTERVAL_SECONDS[kind],
  );
  const [intervalTouched, setIntervalTouched] = useState(check !== null);
  const [notify, setNotify] = useState(check?.notify ?? true);
  const every = intervalTouched ? interval : CHECK_INTERVAL_SECONDS[kind];

  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
    refetchInterval: kind === "site" && draft.method === "command" ? 4_000 : false,
  });
  const sandboxRepos = useSandboxRepos();
  const installations = useInstallations();
  const mailboxes = (installations.data ?? []).filter((i) => i.connectorId === "email");
  const remotes = knownRemotes(runners.data ?? [], sandboxRepos.data ?? []);
  const taken = new Map(targets.map((t) => [t.remoteKey, t.name]));
  const remote = remotes.find((r) => r.remoteKey === draft.remoteKey);
  const deployers = deployMachines(remote);
  const usableDeployers = deployers.filter((m) => !m.blocked);
  const deployRunner =
    draft.runnerId && deployers.some((m) => m.runner.id === draft.runnerId)
      ? draft.runnerId
      : usableDeployers.length === 1
        ? (usableDeployers[0]?.runner.id ?? "")
        : "";
  const machines = machinesOnly(runners.data ?? []).filter((r) =>
    r.capabilities.some((c) => c.name === "shell"),
  );
  const usableMachines = machines.filter((m) => !commandBlocked(m));
  const commandRunner =
    runnerId && machines.some((m) => m.id === runnerId)
      ? runnerId
      : usableMachines.length === 1
        ? (usableMachines[0]?.id ?? "")
        : "";
  const mailbox = installationId || (mailboxes.length === 1 ? (mailboxes[0]?.id ?? "") : "");

  const firstUrl = draft.checks[0]?.url ?? "";
  const suggested =
    kind === "site"
      ? draft.remoteKey
        ? nameFrom(repoNameFor(remote, draft.remoteKey))
        : nameFromUrl(firstUrl)
      : kind === "reply" && from.trim()
        ? `Reply from ${from.trim().split("@")[0]}`
        : "";
  const effectiveName = nameTyped ? name : name || suggested;
  const deploys = kind === "site" && draft.remoteKey !== "";
  const effective: TargetDraft = { ...draft, name: effectiveName, runnerId: deployRunner };

  // ---------------------------------------------------------------- problems
  const errors: DraftErrors = {};
  if (kind === "site") {
    const site = validateDraft(effective, { targets, editing: target });
    for (const [k, v] of Object.entries(site)) {
      if (
        k === "name" ||
        (!deploys &&
          (k === "remoteKey" || k === "runnerId" || k.startsWith("hook") || k === "header"))
      )
        continue;
      errors[k] = v;
    }
  }
  const trimmed = effectiveName.trim();
  if (!trimmed) errors.name = "Give it a name.";
  else if (
    checks.some((c) => c.id !== check?.id && c.name.toLowerCase() === trimmed.toLowerCase())
  ) {
    errors.name = "Another check has this name.";
  }
  if (kind === "command") {
    if (!commandRunner) errors.runnerId = "Pick the machine it runs on.";
    if (!command.trim()) errors.command = "Type the command to run.";
    const t = Number(timeout);
    if (!Number.isInteger(t) || t < 1 || t > 300) errors.timeout = "Whole seconds, 1 to 300.";
  }
  if (kind === "reply") {
    if (!mailbox) errors.mailbox = "Pick the account it arrives in.";
    if (!from.trim() && !subject.trim()) errors.from = "Say who it's from, or what it's about.";
    const at = Date.parse(deadline);
    if (!deadline) errors.deadline = "Pick when it's due.";
    else if (!Number.isFinite(at) || at <= Date.now())
      errors.deadline = "Pick a time that's still to come.";
  }
  const has = (...keys: string[]) => keys.some((k) => errors[k]);
  const shown = (key: string, value: string) => (value.trim() ? errors[key] : undefined);

  // ---------------------------------------------------------------- saving
  const body = (): CheckInput => {
    let config: CheckConfig;
    let deploy: CheckDeployInput | null | undefined;
    if (kind === "site") {
      const b = draftBody(effective, target);
      config = { kind: "site", checks: b.checks, versionUrl: b.versionUrl };
      if (deploys) {
        deploy = {
          remoteKey: b.remoteKey,
          method: b.method,
          mergeMethod: b.mergeMethod ?? "squash",
          ...(b.runnerId ? { runnerId: b.runnerId } : {}),
          ...(b.hook ? { hook: b.hook } : {}),
          ...(b.settleSeconds !== undefined ? { settleSeconds: b.settleSeconds } : {}),
          ...(b.timeoutSeconds !== undefined ? { timeoutSeconds: b.timeoutSeconds } : {}),
        };
      } else if (check?.deploy) deploy = null;
    } else if (kind === "command") {
      config = {
        kind: "command",
        command: command.trim(),
        contains: contains ? contains : null,
        timeoutSeconds: Number(timeout),
      };
    } else {
      config = {
        kind: "reply",
        from: from.trim() || null,
        subject: subject.trim() || null,
        inReplyTo: reply?.inReplyTo ?? null,
        folder: reply?.folder ?? null,
      };
    }
    return {
      name: trimmed,
      config,
      intervalSeconds: every,
      notify,
      ...(kind === "command" ? { runnerId: commandRunner } : {}),
      ...(kind === "reply"
        ? { installationId: mailbox, deadline: new Date(deadline).toISOString() }
        : {}),
      ...(deploy !== undefined ? { deploy } : {}),
    };
  };

  const [ran, setRan] = useState<CheckView | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const b = body();
      const saved = check ? await checkApi.update(check.id, b) : await checkApi.create(b);
      upsertCheck(qc, saved);
      // A new check runs straight away, so the done screen can say what it saw.
      if (!check) {
        const after = await checkApi.run(saved.id).catch(() => saved);
        upsertCheck(qc, after);
        setRan(after);
      }
      return saved;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: checksKey });
      void qc.invalidateQueries({ queryKey: deployTargetsKey });
    },
  });

  // ---------------------------------------------------------------- the common bits
  const nameField = (placeholder: string) => (
    <Field
      label="Name"
      hint={errors.name && effectiveName ? <Problem text={errors.name} /> : undefined}
    >
      <Input
        value={effectiveName}
        maxLength={80}
        placeholder={placeholder}
        aria-invalid={Boolean(errors.name && effectiveName)}
        onChange={(e) => {
          setNameTyped(true);
          setName(e.target.value);
        }}
      />
    </Field>
  );
  const often = (
    <>
      <Field label="How often">
        <Select
          value={String(every)}
          onChange={(e) => {
            setIntervalTouched(true);
            setIntervalSeconds(Number(e.target.value));
          }}
        >
          {[...new Set([...EVERY, every])]
            .sort((a, b) => a - b)
            .map((s) => (
              <option key={s} value={s}>
                {everyText(s)}
              </option>
            ))}
        </Select>
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-soft">Notify my devices when it changes</span>
        <Switch checked={notify} onChange={setNotify} label="Notify my devices when it changes" />
      </div>
    </>
  );

  // ---------------------------------------------------------------- steps
  const kindStep: WizardStep = {
    id: "kind",
    title: "What should Sling watch?",
    content: (
      <OptionCards
        label="Kind"
        options={(["site", "command", "reply"] as const).map((k) => ({
          value: k,
          label: KINDS[k].label,
          detail: KINDS[k].detail,
        }))}
        value={kind}
        onChange={(k) => setKind(k as CheckKind)}
      />
    ),
  };

  const checkKeys = draft.checks.flatMap((_, i) => [`check.${i}.url`, `check.${i}.status`]);
  const pagesStep: WizardStep = {
    id: "pages",
    title: "Which page shows it's up?",
    blocked: has(...checkKeys, "versionUrl", "name"),
    content: (
      <>
        <ChecksFields
          draft={draft}
          shown={shown}
          setDraft={setDraft}
          open={check !== null}
          extra={often}
        />
        {firstUrl.trim() && nameField("Website")}
      </>
    ),
  };

  const deployStep: WizardStep = {
    id: "deploy",
    title: "Does Sling deploy it?",
    blocked: has("remoteKey"),
    content: (
      <RepoChoice
        remotes={remotes}
        taken={taken}
        value={draft.remoteKey}
        loading={runners.isPending || sandboxRepos.isPending}
        none={{
          label: "No, just watch it",
          detail: "Sling checks it and tells you when it's down.",
        }}
        onChange={(key) => setDraft((d) => ({ ...d, remoteKey: key, runnerId: "" }))}
      />
    ),
  };

  const methodStep: WizardStep = {
    id: "method",
    title: "How does it go live?",
    blocked: has("settleSeconds", "timeoutSeconds"),
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
          onChange={(m) => setDraft((d) => ({ ...d, method: m as DeployMethod }))}
        />
        <Disclosure label="More settings" open={target !== null}>
          <Field label="Merge the PR with">
            <Select
              value={draft.mergeMethod}
              onChange={(e) =>
                setDraft((d) => ({ ...d, mergeMethod: e.target.value as MergeMethod }))
              }
            >
              {MERGE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {MERGE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <TimingFields draft={draft} shown={shown} setDraft={setDraft} />
        </Disclosure>
      </>
    ),
  };

  const line = setCommandLine(repoNameFor(remote, draft.remoteKey));
  const deployMachineStep: WizardStep = {
    id: "machine",
    title: "Which machine deploys it?",
    hint: deployers.length === 0 ? "Set the command on the machine that deploys it:" : undefined,
    blocked: !deployRunner,
    content:
      deployers.length === 0 ? (
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
            options={deployers.map((m) => ({
              value: m.runner.id,
              label: m.runner.name,
              detail: m.blocked
                ? `Refuses deploys: ${m.blocked}`
                : `Runs ${m.command}${m.runner.online ? "" : " · offline"}`,
            }))}
            value={deployRunner}
            onChange={(id) => {
              const m = deployers.find((x) => x.runner.id === id);
              if (m && !m.blocked) setDraft((d) => ({ ...d, runnerId: id }));
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
        set={(key, value) => setDraft((d) => ({ ...d, [key]: value }))}
      />
    ),
  };

  const commandStep: WizardStep = {
    id: "command",
    title: "What should it run, and where?",
    blocked: has("runnerId", "command", "timeout", "name"),
    content: (
      <>
        {runners.isPending ? (
          <div className="h-[68px] animate-pulse rounded-xl bg-field shadow-field" />
        ) : machines.length === 0 ? (
          <p className="text-[13px] leading-5 text-muted">
            No machine can run commands yet.{" "}
            <Link to="/machines" className="text-accent-text hover:underline">
              Pair one
            </Link>
            .
          </p>
        ) : (
          <OptionCards
            label="Machine"
            options={machines.map((m) => {
              const blocked = commandBlocked(m);
              return {
                value: m.id,
                label: m.name,
                detail: blocked ? `Can't: ${blocked}` : m.online ? "Online" : "Offline",
              };
            })}
            value={commandRunner}
            onChange={(id) => {
              const m = machines.find((x) => x.id === id);
              if (m && !commandBlocked(m)) setRunnerId(id);
            }}
          />
        )}
        <Field
          label="Command"
          hint="Runs in the machine's read-only sandbox, with no network"
        >
          <Input
            value={command}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            placeholder="test -n &quot;$(find ~/Backups -mtime -1)&quot;"
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
        {command.trim() && nameField("Backup")}
        <Disclosure label="More settings" open={check !== null}>
          <Field label="Output contains" hint="It passes only when the output has this text">
            <Input
              value={contains}
              placeholder="Optional text"
              onChange={(e) => setContains(e.target.value)}
            />
          </Field>
          <Field label="Time limit" hint={<Problem text={errors.timeout} fallback="Seconds" />}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={300}
              value={timeout}
              aria-invalid={Boolean(errors.timeout)}
              onChange={(e) => setTimeoutText(e.target.value)}
            />
          </Field>
          {often}
        </Disclosure>
      </>
    ),
  };

  const replyStep: WizardStep = {
    id: "reply",
    title: "Which reply are you waiting for?",
    blocked: has("mailbox", "from", "deadline", "name"),
    content: (
      <>
        {installations.isPending ? (
          <div className="h-[68px] animate-pulse rounded-xl bg-field shadow-field" />
        ) : mailboxes.length === 0 ? (
          <p className="text-[13px] leading-5 text-muted">
            Sling looks for it in an email account.{" "}
            <Link to="/connectors" className="text-accent-text hover:underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          mailboxes.length > 1 && (
            <OptionCards
              label="Email account"
              options={mailboxes.map((m) => ({ value: m.id, label: m.name }))}
              value={mailbox}
              onChange={setInstallationId}
            />
          )
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="From">
            <Input
              value={from}
              autoComplete="off"
              placeholder="jo@silva.pt"
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="Subject has">
            <Input
              value={subject}
              placeholder="invoice"
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Due by" hint={<Problem text={shown("deadline", deadline)} />}>
          <Input
            type="datetime-local"
            value={deadline}
            aria-invalid={Boolean(shown("deadline", deadline))}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </Field>
        {(from.trim() || subject.trim()) && nameField("Reply from Jo")}
        <Disclosure label="More settings" open={false}>
          {often}
        </Disclosure>
      </>
    ),
  };

  const steps: WizardStep[] = [
    ...(check ? [] : [kindStep]),
    ...(kind === "site"
      ? [
          pagesStep,
          deployStep,
          ...(deploys ? [methodStep] : []),
          ...(deploys && draft.method === "command" ? [deployMachineStep] : []),
          ...(deploys && draft.method === "hook" ? [hookStep] : []),
        ]
      : kind === "command"
        ? [commandStep]
        : [replyStep]),
  ];

  // ---------------------------------------------------------------- review, for editing
  const settle = Number(draft.settleSeconds) || DEFAULT_SETTLE[draft.method];
  const verifyFor = Number(draft.timeoutSeconds) || DEFAULT_TIMEOUT;
  const review: ReviewRow[] | undefined = check
    ? kind === "site"
      ? [
          { stepId: "pages", label: "Name", value: effectiveName },
          {
            stepId: "pages",
            label: "Checks",
            value: draft.checks.map((c) => shortUrl(c.url)).join(", "),
          },
          { stepId: "pages", label: "Version URL", value: draft.versionUrl || "None" },
          { stepId: "pages", label: "Runs", value: everyText(every) },
          { stepId: "deploy", label: "Deploys", value: deploys ? draft.remoteKey : "No" },
          ...(deploys
            ? [
                { stepId: "method", label: "How", value: METHOD[draft.method].short },
                ...(draft.method === "command"
                  ? [
                      {
                        stepId: "machine",
                        label: "Machine",
                        value:
                          deployers.find((m) => m.runner.id === deployRunner)?.runner.name ??
                          "Not set",
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
                          : `Stored for ${target?.hook?.host ?? "the host"}`,
                      },
                    ]
                  : []),
                { stepId: "method", label: "Merge with", value: MERGE_LABEL[draft.mergeMethod] },
                {
                  stepId: "method",
                  label: "After a deploy",
                  value: `Waits ${span(settle)}, checks for ${span(verifyFor)}`,
                },
              ]
            : []),
        ]
      : kind === "command"
        ? [
            { stepId: "command", label: "Name", value: effectiveName },
            {
              stepId: "command",
              label: "Machine",
              value: machines.find((m) => m.id === commandRunner)?.name ?? "Not set",
            },
            {
              stepId: "command",
              label: "Command",
              value: <span className="font-mono">{command}</span>,
            },
            ...(contains ? [{ stepId: "command", label: "Output contains", value: contains }] : []),
            { stepId: "command", label: "Runs", value: everyText(every) },
          ]
        : [
            { stepId: "reply", label: "Name", value: effectiveName },
            {
              stepId: "reply",
              label: "From",
              value: from || "Anyone",
            },
            ...(subject ? [{ stepId: "reply", label: "Subject has", value: subject }] : []),
            {
              stepId: "reply",
              label: "Due by",
              value: deadline ? deadlineText(new Date(deadline).toISOString()) : "Not set",
            },
          ]
    : undefined;

  const result = ran?.lastResult;
  return (
    <Wizard
      title={check ? `Edit ${check.name}` : "Add a check"}
      steps={steps}
      finishLabel={check ? "Save" : "Add"}
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
        check ? undefined : (
          <>
            <p className="text-sm font-medium">{trimmed} is set up</p>
            {result && (
              <p
                className={`mt-1 text-xs leading-4 ${result.passed || ran?.state === "waiting" ? "text-muted" : "text-warn"}`}
              >
                {result.message}
              </p>
            )}
          </>
        )
      }
      onClose={onClose}
    />
  );
}
