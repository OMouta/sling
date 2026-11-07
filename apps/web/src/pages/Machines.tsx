import {
  CHAT_CAPABILITY,
  cloneUrlFor,
  type FoundRepoView,
  HARNESS_LABELS,
  HARNESSES,
  harnessCapability,
  type RepoView,
  type RunnerView,
  type SandboxRepoView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, CheckCheck, Copy, FolderGit2, Laptop, Plus, RefreshCw, Unplug } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, StatsBar, Toolbar } from "../components/Page.tsx";
import { ProviderIcon } from "../components/ProviderIcon.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  Dot,
  Empty,
  ErrorText,
  Input,
  Mono,
  Skeleton,
  Spinner,
  Switch,
  useConfirm,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago, plural } from "../lib/format.ts";
import {
  type AgentStatus,
  codingAgents,
  isAgentCapability,
  machinesOnly,
  splitLabels,
} from "../lib/machines.ts";
import { sandboxApi, useSandboxRepos } from "../lib/sandboxApi.ts";
import type { Enrollment } from "../lib/types.ts";
import { useNow } from "../lib/useNow.ts";
import { qk } from "../lib/workflowApi.ts";
import { machinesRoute } from "../router.tsx";

const CAPABILITY_LABEL: Record<string, string> = {
  ...Object.fromEntries(HARNESSES.map((h) => [harnessCapability(h), HARNESS_LABELS[h]])),
  git: "git",
  "git.pr.github": "GitHub CLI",
};

/** Whether the assistant can run commands on a machine, and how. */
function commandsSummary(runner: RunnerView): { text: string; warn: boolean; detail?: string } {
  const shell = runner.capabilities.find((c) => c.name === "shell");
  const sandbox = runner.capabilities.find((c) => c.name === "shell.sandbox");
  if (!shell) return { text: "Update sling-runner to run commands here", warn: true };
  if (!shell.ready) return { text: "Off", warn: true, detail: shell.detail };
  if (!sandbox?.ready) {
    return {
      text: "No sandbox, so each one asks first",
      warn: true,
      ...(sandbox?.detail ? { detail: sandbox.detail } : {}),
    };
  }
  if (runner.maxMode !== "full-access") {
    return {
      text: "Sandbox only",
      warn: false,
      detail: "Its max mode is below Full access, so commands never leave the read-only sandbox.",
    };
  }
  return {
    text: "Sandboxed unless approved",
    warn: false,
    detail:
      "Commands run in a read-only sandbox. Leaving it asks you first, except in Full access.",
  };
}

/**
 * The workspace's sandbox repo list, keyed by remote. The same repo on two
 * machines shares one entry, so its switch moves on both.
 */
function useSandboxAccess() {
  const qc = useQueryClient();
  const repos = useSandboxRepos();
  const allowed = new Set((repos.data ?? []).map((r) => r.remoteKey));
  const set = (fn: (list: SandboxRepoView[]) => SandboxRepoView[]) =>
    qc.setQueryData<SandboxRepoView[]>(qk.sandboxRepos(), (list) => (list ? fn(list) : list));
  const toggle = useMutation({
    mutationFn: ({ repo, allow }: { repo: RepoView; allow: boolean }) => {
      if (!repo.remoteKey) throw new Error("This repo has no remote.");
      return allow ? sandboxApi.allowRepo(repo) : sandboxApi.disallowRepo(repo.remoteKey);
    },
    // Flip the switch right away; the refetch after settles it either way.
    onMutate: ({ repo, allow }) => {
      const key = repo.remoteKey;
      if (!key) return;
      set((list) => {
        const rest = list.filter((r) => r.remoteKey !== key);
        if (!allow) return rest;
        return [
          ...rest,
          {
            remoteKey: key,
            cloneUrl: cloneUrlFor(key),
            defaultBranch: repo.defaultBranch,
            network: repo.network,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.sandboxRepos() }),
  });
  return {
    loaded: repos.isSuccess,
    error: repos.error ?? toggle.error,
    isAllowed: (key: string) => allowed.has(key),
    pendingKey: toggle.isPending ? toggle.variables?.repo.remoteKey : undefined,
    toggle: (repo: RepoView, allow: boolean) => toggle.mutate({ repo, allow }),
  };
}

type SandboxAccess = ReturnType<typeof useSandboxAccess>;

export function MachinesPage() {
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  const access = useSandboxAccess();
  const search = machinesRoute.useSearch();
  const navigate = useNavigate();
  const [pairing, setPairingState] = useState(Boolean(search.pair));
  const setPairing = (open: boolean) => {
    setPairingState(open);
    if (!open && search.pair) void navigate({ to: "/machines", search: {}, replace: true });
  };
  // A sandbox's Runner is temporary and shows on the Sandboxes page instead.
  const machines = runners.data ? machinesOnly(runners.data) : undefined;

  const online = machines?.filter((m) => m.online).length ?? 0;
  const repos = machines?.reduce((n, m) => n + m.repos.length, 0) ?? 0;
  const allowed = new Set(
    machines?.flatMap((m) =>
      m.repos.flatMap((r) => (r.remoteKey && access.isAllowed(r.remoteKey) ? [r.remoteKey] : [])),
    ),
  ).size;

  return (
    <Page
      title="Machines"
      badge={
        machines && machines.length > 0 ? (
          <Badge tone={online > 0 ? "ok" : "neutral"} dot>
            {online} online
          </Badge>
        ) : undefined
      }
      toolbar={
        <Toolbar
          actions={
            <Button variant="primary" icon={Plus} onClick={() => setPairing(true)}>
              Add machine
            </Button>
          }
        />
      }
      footer={
        machines &&
        machines.length > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-text">{machines.length}</span> machines
              </>,
              <>
                <span className="text-text">{online}</span> online
              </>,
              <>
                <span className="text-text">{repos}</span> repos
              </>,
              <>
                <span className="text-text">{allowed}</span> allowed in sandboxes
              </>,
            ]}
          />
        )
      }
    >
      {/* Wait for the list, so a machine already paired doesn't look new. */}
      {pairing && machines && <PairDialog onClose={() => setPairing(false)} known={machines} />}
      {machines?.length === 0 ? (
        <Empty fill icon={Laptop} title="No machines yet" />
      ) : (
        <div className="space-y-4 px-5 pt-1 pb-6">
          {runners.isPending && <Skeleton className="h-[320px] w-full rounded-xl" />}
          <ErrorText error={runners.error ?? access.error} />
          {machines?.map((r) => (
            <MachineCard key={r.id} runner={r} access={access} />
          ))}
        </div>
      )}
    </Page>
  );
}

function CodeLine({ children, copy }: { children: ReactNode; copy?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-field py-1 pr-1 pl-3 shadow-field">
      <pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-soft">
        {children}
      </pre>
      {copy !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? Check : Copy}
          disabled={!copy}
          onClick={async () => {
            if (!copy) return;
            await navigator.clipboard.writeText(copy);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </div>
  );
}

type InstallTab = "unix" | "windows" | "installed";

function PairDialog({ onClose, known }: { onClose: () => void; known: RunnerView[] }) {
  const create = useMutation({
    mutationFn: () => api.post<Enrollment>("/api/runners/enrollments"),
  });
  const initial = useRef(new Set(known.map((r) => r.id)));
  const paired = known.find((r) => !initial.current.has(r.id));
  const [tab, setTab] = useState<InstallTab>(() =>
    navigator.userAgent.includes("Windows") ? "windows" : "unix",
  );
  const now = useNow(1000, Boolean(create.data) && !paired);

  // biome-ignore lint/correctness/useExhaustiveDependencies: create one code when the dialog opens.
  useEffect(() => {
    create.mutate();
  }, []);

  const e = create.data;
  const left = e ? Math.max(0, new Date(e.expiresAt).getTime() - now) : 0;
  const expired = Boolean(e) && left === 0;
  const command =
    tab === "unix" ? e?.installCommand : tab === "windows" ? e?.windowsInstallCommand : e?.command;

  return (
    <Dialog
      title={paired ? `${paired.name} is paired` : "Pair a machine"}
      description={
        paired ? "Next, pick the repos it may use." : "Run this on the computer with your repos."
      }
      onClose={onClose}
      footer={
        <>
          {paired ? (
            <p className="mr-auto flex items-center gap-2 text-xs text-ok">
              <Dot tone="ok" /> Connected. {plural(paired.foundRepos.length, "repo")} found.
            </p>
          ) : expired ? (
            <p className="mr-auto text-xs text-warn">This code expired.</p>
          ) : (
            <p className="mr-auto flex items-center gap-2 text-xs text-muted">
              <Spinner className="size-3.5" /> Waiting for the machine
              {e && (
                <span className="tabular text-subtle">
                  · code expires in {Math.floor(left / 60_000)}:
                  {String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}
                </span>
              )}
            </p>
          )}
          {expired && !paired && (
            <Button icon={RefreshCw} busy={create.isPending} onClick={() => create.mutate()}>
              New code
            </Button>
          )}
          <Button variant={paired ? "primary" : "secondary"} onClick={onClose}>
            {paired ? "Pick repos" : "Close"}
          </Button>
        </>
      }
    >
      {!paired && (
        <div className="space-y-4">
          <div
            role="tablist"
            aria-label="System"
            className="flex w-fit rounded-full bg-field p-0.5 shadow-field"
          >
            {(
              [
                ["unix", "macOS and Linux"],
                ["windows", "Windows"],
                ["installed", "Already installed"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cx(
                  "h-[26px] cursor-pointer rounded-full px-3 text-xs transition-colors duration-150",
                  tab === id
                    ? "bg-surface-3 text-text shadow-active"
                    : "text-subtle hover:text-soft",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <CodeLine copy={command ?? ""}>{command ?? "…"}</CodeLine>
          <p className="text-xs leading-[18px] text-muted">
            {tab === "installed"
              ? "Then run sling-runner service install to keep it running."
              : "Needs git and a logged-in Codex or Claude Code."}
          </p>
          <ErrorText error={create.error} />
        </div>
      )}
    </Dialog>
  );
}

const OS_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

function MachineCard({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/runners/${runner.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runners"] }),
  });
  const { confirm, dialog } = useConfirm();
  const tools = runner.capabilities.filter(
    (c) => !isAgentCapability(c.name) && c.name !== CHAT_CAPABILITY && !c.name.startsWith("shell"),
  );
  const canChat = runner.capabilities.some((c) => c.name === CHAT_CAPABILITY && c.ready);
  const commands = commandsSummary(runner);
  const facts = [
    runner.os && (OS_LABEL[runner.os] ?? runner.os),
    runner.arch,
    runner.version && `sling-runner ${runner.version}`,
    runner.hostname && runner.hostname !== runner.name && runner.hostname,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
          <Laptop aria-hidden="true" size={16} />
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface p-[2px]">
            <Dot tone={runner.online ? "ok" : "neutral"} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate font-medium">{runner.name}</span>
            <span className={cx("shrink-0 text-xs", runner.online ? "text-ok" : "text-muted")}>
              {runner.online ? "Online" : `Offline, last seen ${ago(runner.lastSeenAt)}`}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-subtle">{facts.join(" · ")}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-subtle max-sm:hidden">Up to</span>
          <ModeBadge mode={runner.maxMode} />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={Unplug}
            aria-label={`Revoke ${runner.name}`}
            title={`Revoke ${runner.name}`}
            busy={revoke.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Revoke ${runner.name}?`,
                body: "Tasks running on it stop, and it has to be paired again.",
                action: "Revoke",
                danger: true,
              });
              if (ok) revoke.mutate();
            }}
          />
        </span>
      </div>

      <ul
        aria-label={`Coding agents on ${runner.name}`}
        className="grid border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-border max-sm:divide-y max-sm:divide-border"
      >
        {codingAgents(runner).map((a) => (
          <AgentTile
            key={a.harness}
            agent={a}
            models={
              runner.capabilities.find((c) => c.name === harnessCapability(a.harness))?.models
                ?.length ?? 0
            }
          />
        ))}
      </ul>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <dt className="text-subtle">Tools</dt>
          <dd className="flex items-center gap-1.5 text-soft">
            {tools.length === 0
              ? "None found"
              : tools.map((c, i) => (
                  <span
                    key={c.name}
                    title={c.detail || undefined}
                    className={c.ready ? undefined : "text-warn"}
                  >
                    {i > 0 && <span className="mr-1.5 text-faint">·</span>}
                    {CAPABILITY_LABEL[c.name] ?? c.name}
                    {c.version ? ` ${c.version}` : ""}
                    {c.ready ? "" : " (not ready)"}
                  </span>
                ))}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-subtle">Tasks at once</dt>
          <dd className="tabular text-soft">{runner.maxConcurrentTasks}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-subtle">Commands</dt>
          <dd className={commands.warn ? "text-warn" : "text-soft"} title={commands.detail}>
            {commands.text}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-subtle">Chat</dt>
          <dd className={canChat ? "text-soft" : "text-warn"}>
            {canChat ? "Yes" : "Update sling-runner to chat here"}
          </dd>
        </div>
        {runner.labels.length > 0 && (
          <div className="flex items-center gap-2">
            <dt className="text-subtle">Labels</dt>
            <dd>
              <Labels labels={runner.labels} />
            </dd>
          </div>
        )}
      </dl>

      <RepoSection runner={runner} access={access} />
      {dialog}
      {revoke.error ? (
        <div className="px-4 pb-3">
          <ErrorText error={revoke.error} />
        </div>
      ) : null}
    </Card>
  );
}

/** One coding agent on a machine, always two lines, whatever its state. */
function AgentTile({ agent: a, models }: { agent: AgentStatus; models: number }) {
  const detail = a.ready
    ? [a.detail, models > 0 && plural(models, "model")].filter(Boolean).join(" · ")
    : a.installed
      ? a.detail || "Not logged in"
      : "Not installed";
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 shadow-raised">
        <ProviderIcon provider={a.harness} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          {a.label}
          {a.version && <span className="ml-1.5 font-normal text-subtle">{a.version}</span>}
        </p>
        <p
          className={cx("truncate text-xs", a.ready || !a.installed ? "text-muted" : "text-warn")}
          title={detail}
        >
          {detail}
        </p>
      </div>
      <Badge tone={a.ready ? "ok" : a.installed ? "warn" : "neutral"} dot={a.ready}>
        {a.ready ? "Ready" : a.installed ? "Not ready" : "Missing"}
      </Badge>
    </li>
  );
}

type RepoItem =
  | { kind: "allowed"; name: string; repo: RepoView }
  | { kind: "found"; name: string; found: FoundRepoView };

/**
 * Every repo on the machine in one list, by name: the allowed ones and the
 * ones it found. Allowing or removing flips a row's switch in place, so
 * nothing moves while the machine catches up.
 */
function RepoSection({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  // Names whose switch was flipped, until the machine's list agrees.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const { confirm, dialog } = useConfirm();
  const refresh = () => qc.invalidateQueries({ queryKey: ["runners"] });
  const settle = (names: string[]) =>
    setPending((p) => {
      const next = { ...p };
      for (const n of names) delete next[n];
      return next;
    });
  const allow = useMutation({
    mutationFn: (items: { name: string; path: string }[]) =>
      api.post<{ ok: boolean; message: string }>(
        `/api/runners/${runner.id}/repos`,
        items.length === 1 ? { path: items[0]?.path } : { paths: items.map((i) => i.path) },
      ),
    onMutate: (items) => setPending((p) => ({ ...p, ...flags(items, true) })),
    onError: (_e, items) => settle(items.map((i) => i.name)),
    onSuccess: (_r, items) => afterChange(items.map((i) => i.name)),
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      api.del(`/api/runners/${runner.id}/repos/${encodeURIComponent(name)}`),
    onMutate: (name) => setPending((p) => ({ ...p, [name]: false })),
    onError: (_e, name) => settle([name]),
    onSuccess: (_r, name) => afterChange([name]),
  });
  // The machine's new list normally settles the switches. If it never comes,
  // they show what the machine last said.
  function afterChange(names: string[]) {
    void refresh();
    setTimeout(() => settle(names), 15_000);
  }
  const scan = useMutation({ mutationFn: () => api.post(`/api/runners/${runner.id}/scan`) });

  // Allowed repos come first, as they were when the page opened. A repo keeps
  // its place after that, so flipping its switch never moves it.
  const firstSeen = useRef(new Map<string, boolean>());
  const items = useMemo<RepoItem[]>(() => {
    const all: RepoItem[] = [
      ...runner.repos.map((repo) => ({ kind: "allowed" as const, name: repo.name, repo })),
      ...runner.foundRepos.map((found) => ({ kind: "found" as const, name: found.name, found })),
    ];
    const seen = firstSeen.current;
    for (const it of all) if (!seen.has(it.name)) seen.set(it.name, it.kind === "allowed");
    const rank = (it: RepoItem) => (seen.get(it.name) ? 0 : 1);
    return all.sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }, [runner.repos, runner.foundRepos]);
  // A flipped switch settles once the machine's list shows the change.
  useEffect(() => {
    setPending((p) => {
      const done = Object.keys(p).filter((name) => {
        const it = items.find((i) => i.name === name);
        return !it || (it.kind === "allowed") === p[name];
      });
      if (done.length === 0) return p;
      const next = { ...p };
      for (const n of done) delete next[n];
      return next;
    });
  }, [items]);

  const canChange = runner.online && runner.remoteRepos;
  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.kind === "found" ? i.found.path : i.repo.remoteUrl).toLowerCase().includes(q),
      )
    : items;
  const allowable = shown.flatMap((i) =>
    i.kind === "found" && pending[i.name] === undefined
      ? [{ name: i.name, path: i.found.path }]
      : [],
  );
  const allowedCount = items.filter((i) => pending[i.name] ?? i.kind === "allowed").length;
  const error = allow.error ?? remove.error ?? scan.error;

  async function allowAll() {
    const n = allowable.length;
    const ok = await confirm({
      title: `Allow ${plural(n, "repo")} on ${runner.name}?`,
      body: `Coding agents can then work in ${n === 1 ? "it" : "them"}, with network access off.`,
      action: `Allow ${plural(n, "repo")}`,
    });
    if (ok) allow.mutate(allowable);
  }

  let status: ReactNode = null;
  if (error) {
    status = (
      <span className="text-danger">{error instanceof Error ? error.message : String(error)}</span>
    );
  } else if (!runner.remoteRepos) {
    status = (
      <>
        To change repos from here, run <Mono>sling-runner config set remote-repos on</Mono> on the
        machine.
      </>
    );
  } else if (!runner.online) {
    status = "Offline. Repos can be changed once it's back.";
  }

  return (
    <section aria-label={`Repos on ${runner.name}`} className="border-t border-border">
      <div className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-2">
        <span className="section-label">Repos</span>
        <span className="text-xs text-subtle tabular">
          {allowedCount} allowed
          {items.length > allowedCount && ` · ${items.length - allowedCount} not allowed`}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {items.length > 8 && (
            <Input
              aria-label={`Filter repos on ${runner.name}`}
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 w-36"
            />
          )}
          {canChange && (
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              busy={scan.isPending}
              onClick={() => scan.mutate()}
            >
              Look again
            </Button>
          )}
          {canChange && (
            <Button
              size="sm"
              icon={CheckCheck}
              disabled={allowable.length === 0}
              onClick={allowAll}
            >
              {q ? "Allow these" : "Allow all"}
            </Button>
          )}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-xs text-muted">No git repos found.</p>
      ) : (
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto border-t border-border">
          <div
            aria-hidden="true"
            className={cx(
              REPO_GRID,
              "sticky top-0 z-[1] h-8 bg-surface text-[11px] font-medium text-subtle",
            )}
          >
            <span />
            <span>Repo</span>
            <span className="max-sm:hidden">Branch</span>
            <span title="Run tasks in a sandbox when no machine can">Sandboxes</span>
            <span className="text-right">Allowed</span>
          </div>
          <ul aria-label={`Repo list for ${runner.name}`}>
            {shown.map((it) => (
              <RepoRow
                key={it.name}
                item={it}
                allowed={pending[it.name] ?? it.kind === "allowed"}
                busy={pending[it.name] !== undefined}
                canChange={canChange}
                access={access}
                onAllow={() =>
                  it.kind === "found" && allow.mutate([{ name: it.name, path: it.found.path }])
                }
                onRemove={() => remove.mutate(it.name)}
              />
            ))}
            {shown.length === 0 && (
              <li className="border-t border-border px-4 py-4 text-xs text-muted">
                No matching repos.
              </li>
            )}
          </ul>
        </div>
      )}
      {status && (
        <p className="border-t border-border px-4 py-2.5 text-xs leading-4 text-subtle">{status}</p>
      )}
      {dialog}
    </section>
  );
}

function flags(items: { name: string }[], value: boolean) {
  return Object.fromEntries(items.map((i) => [i.name, value]));
}

const REPO_GRID =
  "grid grid-cols-[16px_minmax(0,1fr)_76px_56px] sm:grid-cols-[16px_minmax(0,1fr)_96px_76px_56px] items-center gap-x-3 px-4";

function RepoRow({
  item,
  allowed,
  busy,
  canChange,
  access,
  onAllow,
  onRemove,
}: {
  item: RepoItem;
  allowed: boolean;
  busy: boolean;
  canChange: boolean;
  access: SandboxAccess;
  onAllow: () => void;
  onRemove: () => void;
}) {
  const repo = item.kind === "allowed" ? item.repo : null;
  const found = item.kind === "found" ? item.found : null;
  const branch = repo?.defaultBranch ?? found?.defaultBranch ?? "";
  const key = repo?.remoteKey ?? null;
  return (
    <li className={cx(REPO_GRID, "h-[52px] border-t border-border first:border-t-0")}>
      <FolderGit2 aria-hidden="true" className={allowed ? "text-icon" : "text-faint"} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className={cx("truncate", allowed ? "font-medium text-text" : "text-soft")}>
            {item.name}
          </span>
          {repo?.network && <Badge tone="warn">network on</Badge>}
        </p>
        {found ? (
          // Truncates from the start, so the end of the path stays visible.
          <p
            className="truncate text-left font-mono text-[11px] text-subtle [direction:rtl]"
            title={found.path}
          >
            <bdi>{found.path}</bdi>
          </p>
        ) : (
          <p className="truncate text-[11px] text-subtle" title={repo?.remoteUrl || undefined}>
            {repo?.remoteUrl || "No remote"}
          </p>
        )}
      </div>
      <span className="truncate max-sm:hidden">{branch && <Mono>{branch}</Mono>}</span>
      <span className="flex items-center">
        {repo && key ? (
          <Switch
            size="sm"
            checked={access.isAllowed(key)}
            label={`Allow ${repo.name} in sandboxes`}
            disabled={!access.loaded || access.pendingKey === key}
            onChange={(on) => access.toggle(repo, on)}
          />
        ) : repo ? (
          <span
            className="text-[11px] text-faint"
            title="No remote, so a sandbox has nothing to clone."
          >
            No remote
          </span>
        ) : null}
      </span>
      <span className="flex items-center justify-end gap-1.5">
        {busy && <Spinner className="size-3" />}
        <Switch
          size="sm"
          checked={allowed}
          label={allowed ? `Stop allowing ${item.name}` : `Allow ${item.name}`}
          disabled={!canChange || busy}
          onChange={(on) => (on ? onAllow() : onRemove())}
        />
      </span>
    </li>
  );
}

/** Labels set on the machine, then the automatic `os:` and `arch:` ones, quieter. */
function Labels({ labels }: { labels: string[] }) {
  const { own, automatic } = splitLabels(labels);
  if (own.length + automatic.length === 0) return null;
  return (
    <ul aria-label="Labels" className="flex flex-wrap items-center gap-1.5">
      {own.map((l) => (
        <li key={l}>
          <Badge tone="accent">{l}</Badge>
        </li>
      ))}
      {automatic.map((l) => (
        <li
          key={l}
          title="Set automatically"
          className="inline-flex h-[22px] items-center rounded-full border border-border px-2 font-mono text-[11px] text-muted"
        >
          {l}
        </li>
      ))}
    </ul>
  );
}
