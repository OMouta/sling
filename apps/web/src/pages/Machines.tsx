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
import { Check, Copy, FolderGit2, Laptop, Plus, Unplug } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, StatsBar, Toolbar, ToolbarText } from "../components/Page.tsx";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Dot,
  Empty,
  ErrorText,
  Mono,
  Skeleton,
  Spinner,
  Switch,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { codingAgents, isAgentCapability, machinesOnly, splitLabels } from "../lib/machines.ts";
import { sandboxApi, useSandboxRepos } from "../lib/sandboxApi.ts";
import type { Enrollment } from "../lib/types.ts";
import { qk } from "../lib/workflowApi.ts";

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
  const [pairing, setPairing] = useState(false);
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
      {pairing && <PairDialog onClose={() => setPairing(false)} known={machines ?? []} />}
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
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-xs text-soft">
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

function PairDialog({ onClose, known }: { onClose: () => void; known: RunnerView[] }) {
  const create = useMutation({
    mutationFn: () => api.post<Enrollment>("/api/runners/enrollments"),
  });
  const initial = useRef(new Set(known.map((r) => r.id)));
  const paired = known.find((r) => !initial.current.has(r.id));

  // biome-ignore lint/correctness/useExhaustiveDependencies: create one code when the dialog opens.
  useEffect(() => {
    create.mutate();
  }, []);

  const command = create.data?.command;
  return (
    <Dialog
      title="Pair a machine"
      description="On the machine, install sling-runner, add the repos Sling may use, then run the command below. The code works once and expires in 10 minutes."
      onClose={onClose}
      footer={
        <>
          {paired ? (
            <p className="mr-auto flex items-center gap-2 text-xs text-ok">
              <Dot tone="ok" /> {paired.name} is paired.
            </p>
          ) : (
            <p className="mr-auto flex items-center gap-2 text-xs text-muted">
              <Spinner className="size-3.5" /> Waiting for the machine
            </p>
          )}
          <Button variant={paired ? "primary" : "secondary"} onClick={onClose}>
            {paired ? "Done" : "Close"}
          </Button>
        </>
      }
    >
      <ol className="space-y-4">
        <Step n={1} title="Allow a repo">
          <CodeLine copy="sling-runner repo add ~/code/my-repo">
            sling-runner repo add ~/code/my-repo
          </CodeLine>
        </Step>
        <Step n={2} title="Pair">
          <CodeLine copy={command ?? ""}>{command ?? "…"}</CodeLine>
        </Step>
        <Step n={3} title="Start it">
          <CodeLine copy="sling-runner service install">sling-runner service install</CodeLine>
        </Step>
      </ol>
      <ErrorText error={create.error} />
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tabular mt-px grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-medium text-soft">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[13px] font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function MachineCard({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/runners/${runner.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runners"] }),
  });
  const problems = runner.capabilities.filter((c) => !c.ready && c.detail);
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
            onClick={() => {
              if (
                window.confirm(
                  `Revoke ${runner.name}? It disconnects now and has to be paired again.`,
                )
              ) {
                revoke.mutate();
              }
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

      <div className="border-t border-border">
        {runner.repos.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">
            No repos. Add one on the machine with <Mono>sling-runner repo add</Mono>.
          </p>
        ) : (
          <>
            <ul>
              {runner.repos.map((p) => (
                <RepoRow key={p.id} repo={p} access={access} />
              ))}
            </ul>
            {runner.repos.some((p) => p.remoteKey) && (
              <p className="border-t border-border px-4 py-3 text-xs leading-4 text-subtle">
                Allow in sandboxes lets Sling run a task for the repo in a fresh sandbox when no
                machine can take it. The sandbox clones the repo from its remote, so local files and
                uncommitted work never leave this machine.
              </p>
            )}
          </>
        )}
      </div>
      {revoke.error ? (
        <div className="px-4 pb-3">
          <ErrorText error={revoke.error} />
        </div>
      ) : null}
    </Card>
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

function RepoRow({ repo, access }: { repo: RepoView; access: SandboxAccess }) {
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
      </span>
    </li>
  );
}
