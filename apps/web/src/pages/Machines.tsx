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
import { useEffect, useRef, useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import {
  Badge,
  Button,
  Card,
  Dot,
  Empty,
  ErrorText,
  PageHeader,
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <PageHeader
        title="Machines"
        description="Computers running sling-runner. Repos and the permission cap are set on each machine."
        actions={
          <Button variant="primary" onClick={() => setPairing(true)}>
            Add machine
          </Button>
        }
      />
      {pairing && <PairPanel onClose={() => setPairing(false)} known={machines ?? []} />}
      {runners.isPending && <Spinner />}
      <ErrorText error={runners.error ?? access.error} />
      {machines?.length === 0 && !pairing && (
        <Empty title="No machines yet">Add one to let Sling run Codex or Claude Code on it.</Empty>
      )}
      <div className="space-y-3">
        {machines?.map((r) => (
          <MachineCard key={r.id} runner={r} access={access} />
        ))}
      </div>
    </div>
  );
}

function PairPanel({ onClose, known }: { onClose: () => void; known: RunnerView[] }) {
  const create = useMutation({
    mutationFn: () => api.post<Enrollment>("/api/runners/enrollments"),
  });
  const initial = useRef(new Set(known.map((r) => r.id)));
  const paired = known.find((r) => !initial.current.has(r.id));
  const [copied, setCopied] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: create one code when the panel opens.
  useEffect(() => {
    create.mutate();
  }, []);

  const command = create.data?.command;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Pair a machine</h2>
          <p className="mt-1 text-sm text-muted">
            On the machine, install sling-runner, add the repos Sling may use, then run the command
            below. The code works once and expires in 10 minutes.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <ol className="space-y-3 text-sm">
        <li>
          <p className="mb-1 text-muted">1. Allow a repo</p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            sling-runner repo add ~/code/my-repo
          </pre>
        </li>
        <li>
          <p className="mb-1 text-muted">2. Pair</p>
          <div className="flex items-center gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
              {command ?? "…"}
            </pre>
            <Button
              size="sm"
              disabled={!command}
              onClick={async () => {
                if (!command) return;
                await navigator.clipboard.writeText(command);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </li>
        <li>
          <p className="mb-1 text-muted">3. Start it</p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            sling-runner service install
          </pre>
        </li>
      </ol>
      <ErrorText error={create.error} />
      {paired ? (
        <p className="flex items-center gap-2 text-sm text-ok">
          <Dot tone="ok" /> {paired.name} is paired.
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-3.5" /> Waiting for the machine
        </p>
      )}
    </Card>
  );
}

function MachineCard({ runner, access }: { runner: RunnerView; access: SandboxAccess }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/runners/${runner.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runners"] }),
  });
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone={runner.online ? "ok" : "neutral"} />
        <span className="font-medium">{runner.name}</span>
        <span className="text-sm text-muted">
          {runner.online ? "online" : `last seen ${ago(runner.lastSeenAt)}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">Max</span>
          <ModeBadge mode={runner.maxMode} />
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {[runner.hostname, runner.os, runner.arch, runner.version && `runner ${runner.version}`]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <Labels labels={runner.labels} />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted">Coding agents</span>
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
              <Badge tone={c.ready ? "ok" : "warn"}>
                {CAPABILITY_LABEL[c.name] ?? c.name}
                {c.version ? ` ${c.version}` : ""}
                {c.ready ? "" : " · not ready"}
              </Badge>
            </span>
          ))}
      </div>
      {runner.capabilities
        .filter((c) => !c.ready && c.detail)
        .map((c) => (
          <p key={c.name} className="mt-1.5 text-xs text-warn">
            {CAPABILITY_LABEL[c.name] ?? c.name}: {c.detail}
          </p>
        ))}
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">Repos</p>
        {runner.repos.length === 0 ? (
          <p className="mt-1 text-sm text-muted">
            None. Add one on the machine with{" "}
            <code className="font-mono text-xs">sling-runner repo add</code>.
          </p>
        ) : (
          <>
            <ul className="mt-1 space-y-1.5">
              {runner.repos.map((p) => (
                <RepoRow key={p.id} repo={p} access={access} />
              ))}
            </ul>
            {runner.repos.some((p) => p.remoteKey) && (
              <p className="mt-2 text-xs text-muted">
                Allow in sandboxes lets Sling run a task for the repo in a fresh sandbox when no
                machine can take it. The sandbox clones the repo from its remote, so local files and
                uncommitted work never leave this machine.
              </p>
            )}
          </>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="danger"
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
      </div>
      <ErrorText error={revoke.error} />
    </Card>
  );
}

/** Labels set on the machine, then the automatic `os:` and `arch:` ones, quieter. */
function Labels({ labels }: { labels: string[] }) {
  const { own, automatic } = splitLabels(labels);
  if (own.length + automatic.length === 0) return null;
  return (
    <ul aria-label="Labels" className="mt-2 flex flex-wrap items-center gap-1.5">
      {own.map((l) => (
        <li key={l}>
          <Badge tone="accent">{l}</Badge>
        </li>
      ))}
      {automatic.map((l) => (
        <li
          key={l}
          title="Set automatically"
          className="inline-flex h-5 items-center rounded-full border border-border px-2 font-mono text-[11px] text-muted"
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
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="font-medium">{repo.name}</span>
      <span className="text-muted">{repo.defaultBranch}</span>
      {repo.network && <Badge tone="warn">network on</Badge>}
      <span className="min-w-0 truncate text-xs text-muted">{repo.remoteUrl}</span>
      <span className="ml-auto flex items-center gap-2 text-xs text-muted">
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
