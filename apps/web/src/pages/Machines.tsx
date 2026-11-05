import {
  cloneUrlFor,
  HARNESS_LABELS,
  HARNESSES,
  harnessCapability,
  type RepoView,
  type RunnerView,
  type SandboxRepoView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, FolderGit2, Laptop, Plus, RefreshCw, Unplug, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, StatsBar, Toolbar, ToolbarText } from "../components/Page.tsx";
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
import { codingAgents, isAgentCapability, machinesOnly, splitLabels } from "../lib/machines.ts";
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
        >
          <ToolbarText>
            Computers running sling-runner. Repos and the permission cap are set on each machine.
          </ToolbarText>
        </Toolbar>
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
      <div className="space-y-4 px-5 pt-1 pb-6">
        {runners.isPending && <Skeleton className="h-48 w-full rounded-xl" />}
        <ErrorText error={runners.error ?? access.error} />
        {machines?.length === 0 && (
          <Empty
            icon={Laptop}
            title="No machines yet"
            action={
              <Button variant="primary" icon={Plus} onClick={() => setPairing(true)}>
                Add machine
              </Button>
            }
          >
            Add one to let Sling run Codex or Claude Code on it.
          </Empty>
        )}
        {machines?.map((r) => (
          <MachineCard key={r.id} runner={r} access={access} />
        ))}
      </div>
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
        paired
          ? "Pick the repos Sling may use on it. They're listed on its card."
          : "Run one command on the computer that has your repos and Codex or Claude Code."
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
              ? "Pairs this machine and starts nothing else. Run sling-runner service install afterwards to keep it running."
              : "It installs sling-runner, pairs it with this code, and starts it in the background. The code works once."}{" "}
            The machine needs git, and Codex or Claude Code logged in.
          </p>
          <ErrorText error={create.error} />
        </div>
      )}
    </Dialog>
  );
}

function MachineCard({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/runners/${runner.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runners"] }),
  });
  const problems = runner.capabilities.filter((c) => !c.ready && c.detail);
  const { confirm, dialog } = useConfirm();
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
          <Laptop aria-hidden="true" size={16} />
          <span className="absolute -right-0.5 -bottom-0.5 rounded-full p-[2px] bg-surface">
            <Dot tone={runner.online ? "ok" : "neutral"} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm">
            <span className="font-medium">{runner.name}</span>
            <span className={runner.online ? "text-xs text-ok" : "text-xs text-muted"}>
              {runner.online ? "online" : `last seen ${ago(runner.lastSeenAt)}`}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-subtle">
            {[runner.hostname, runner.os, runner.arch, runner.version && `runner ${runner.version}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className="flex items-center gap-2">
          <span className="text-xs text-subtle">Max</span>
          <ModeBadge mode={runner.maxMode} />
          <Button
            size="sm"
            variant="ghost-danger"
            icon={Unplug}
            busy={revoke.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Revoke ${runner.name}?`,
                body: "It disconnects now and has to be paired again. Tasks running on it stop.",
                action: "Revoke",
                danger: true,
              });
              if (ok) revoke.mutate();
            }}
          >
            Revoke
          </Button>
        </span>
      </div>

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-[120px_1fr]">
        <p className="pt-[3px] text-xs text-subtle">Coding agents</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {codingAgents(runner).map((a) => (
            <span key={a.harness} title={a.detail || undefined}>
              <Badge tone={a.ready ? "ok" : a.installed ? "warn" : "neutral"}>
                {a.label}
                {a.version ? ` ${a.version}` : ""}
                {a.ready ? "" : a.installed ? " · not ready" : " · not installed"}
              </Badge>
            </span>
          ))}
          {runner.capabilities
            .filter((c) => !isAgentCapability(c.name))
            .map((c) => (
              <span key={c.name} title={c.detail || undefined}>
                <Badge tone={c.ready ? "neutral" : "warn"}>
                  {CAPABILITY_LABEL[c.name] ?? c.name}
                  {c.version ? ` ${c.version}` : ""}
                  {c.ready ? "" : " · not ready"}
                </Badge>
              </span>
            ))}
          {problems.map((c) => (
            <p key={c.name} className="w-full text-xs text-warn">
              {CAPABILITY_LABEL[c.name] ?? c.name}: {c.detail}
            </p>
          ))}
        </div>
        {runner.labels.length > 0 && (
          <>
            <p className="pt-[3px] text-xs text-subtle">Labels</p>
            <Labels labels={runner.labels} />
          </>
        )}
      </div>

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

/** Allowed repos, then the ones the machine found that Sling may be allowed to use. */
function RepoSection({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["runners"] });
  const allow = useMutation({
    mutationFn: (path: string) => api.post(`/api/runners/${runner.id}/repos`, { path }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      api.del(`/api/runners/${runner.id}/repos/${encodeURIComponent(name)}`),
    onSuccess: refresh,
  });
  const scan = useMutation({ mutationFn: () => api.post(`/api/runners/${runner.id}/scan`) });
  const canChange = runner.online && runner.remoteRepos;
  const q = filter.trim().toLowerCase();
  const found = runner.foundRepos.filter(
    (f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
  );
  const shown = showAll || q ? found : found.slice(0, 6);

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className="section-label">Repos</span>
        <span className="ml-auto" />
        {runner.online && runner.remoteRepos && (
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
      </div>
      {runner.repos.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-muted">
          {runner.foundRepos.length > 0
            ? "None allowed yet. Pick the ones Sling may work in below."
            : "None allowed yet."}
        </p>
      ) : (
        <ul aria-label={`Repos on ${runner.name}`}>
          {runner.repos.map((p) => (
            <RepoRow
              key={p.id}
              repo={p}
              access={access}
              onRemove={canChange ? () => remove.mutate(p.name) : undefined}
              removing={remove.isPending && remove.variables === p.name}
            />
          ))}
        </ul>
      )}
      {runner.repos.some((p) => p.remoteKey) && (
        <p className="border-t border-border px-4 py-3 text-xs leading-4 text-subtle">
          Allow in sandboxes lets Sling run a task for the repo in a fresh sandbox when no machine
          can take it. The sandbox clones the repo from its remote, so local files and uncommitted
          work never leave this machine.
        </p>
      )}

      {runner.remoteRepos && runner.foundRepos.length > 0 && (
        <div className="border-t border-border bg-sidebar/60">
          <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
            <span className="text-xs font-medium text-soft">
              Found on {runner.name}
              <span className="ml-1.5 text-subtle tabular">{runner.foundRepos.length}</span>
            </span>
            {runner.foundRepos.length > 8 && (
              <Input
                aria-label="Filter found repos"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="ml-auto h-7 max-w-44"
              />
            )}
          </div>
          <ul aria-label={`Repos found on ${runner.name}`}>
            {shown.map((f) => (
              <li
                key={f.path}
                className="flex min-h-[43px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0"
              >
                <FolderGit2 aria-hidden="true" className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-soft">{f.name}</p>
                  {/* Truncates from the start, so the end of the path stays visible. */}
                  <p
                    className="truncate text-left font-mono text-[11px] text-subtle [direction:rtl]"
                    title={f.path}
                  >
                    <bdi>{f.path}</bdi>
                  </p>
                </div>
                {f.remoteUrl && (
                  <span className="hidden max-w-56 truncate text-xs text-subtle md:inline">
                    {f.remoteUrl}
                  </span>
                )}
                <Button
                  size="sm"
                  icon={Plus}
                  aria-label={`Allow ${f.name}`}
                  disabled={!runner.online}
                  busy={allow.isPending && allow.variables === f.path}
                  onClick={() => allow.mutate(f.path)}
                >
                  Allow
                </Button>
              </li>
            ))}
          </ul>
          {!showAll && !q && found.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full cursor-pointer border-t border-border px-4 py-2.5 text-left text-xs text-subtle hover:text-text"
            >
              Show all {found.length}
            </button>
          )}
        </div>
      )}
      {!runner.remoteRepos && (
        <p className="border-t border-border px-4 py-3 text-xs leading-4 text-subtle">
          This machine doesn't take repo changes from Sling. Add repos on it with{" "}
          <Mono>sling-runner repo add</Mono>, or allow changes from here with{" "}
          <Mono>sling-runner config set remote-repos on</Mono>.
        </p>
      )}
      {(allow.error || remove.error || scan.error) && (
        <div className="px-4 pb-3">
          <ErrorText error={allow.error ?? remove.error ?? scan.error} />
        </div>
      )}
    </div>
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

function RepoRow({
  repo,
  access,
  onRemove,
  removing,
}: {
  repo: RepoView;
  access: SandboxAccess;
  onRemove?: (() => void) | undefined;
  removing?: boolean;
}) {
  const key = repo.remoteKey;
  return (
    <li className="flex min-h-[43px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0">
      <FolderGit2 aria-hidden="true" className="text-subtle" />
      <span className="text-[13px] font-medium">{repo.name}</span>
      <Mono>{repo.defaultBranch}</Mono>
      {repo.network && <Badge tone="warn">network on</Badge>}
      <span className="min-w-0 flex-1 truncate text-xs text-subtle">{repo.remoteUrl}</span>
      <span className="flex items-center gap-2 text-xs text-muted">
        {key ? (
          <>
            <span
              title={`A sandbox clones ${key} from its remote. Files on this machine never leave it.`}
            >
              Allow in sandboxes
            </span>
            <Switch
              size="sm"
              checked={access.isAllowed(key)}
              label={`Allow ${repo.name} in sandboxes`}
              disabled={!access.loaded || access.pendingKey === key}
              onChange={(allow) => access.toggle(repo, allow)}
            />
          </>
        ) : (
          <span>No remote, so a sandbox has nothing to clone</span>
        )}
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={X}
            busy={removing}
            aria-label={`Stop allowing ${repo.name}`}
            title={`Stop allowing ${repo.name}`}
            onClick={onRemove}
          />
        )}
      </span>
    </li>
  );
}
