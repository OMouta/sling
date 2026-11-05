import type { RunnerView } from "@sling/core";
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
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import type { Enrollment } from "../lib/types.ts";

const CAPABILITY_LABEL: Record<string, string> = {
  "coding.codex": "Codex",
  git: "git",
  "git.pr.github": "GitHub CLI",
};

export function MachinesPage() {
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  const [pairing, setPairing] = useState(false);

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
      {pairing && <PairPanel onClose={() => setPairing(false)} known={runners.data ?? []} />}
      {runners.isPending && <Spinner />}
      <ErrorText error={runners.error} />
      {runners.data?.length === 0 && !pairing && (
        <Empty title="No machines yet">Add one to let Sling run Codex on it.</Empty>
      )}
      <div className="space-y-3">
        {runners.data?.map((r) => (
          <MachineCard key={r.id} runner={r} />
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

function MachineCard({ runner }: { runner: RunnerView }) {
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
      <div className="mt-3 flex flex-wrap gap-1.5">
        {runner.capabilities.map((c) => (
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
          <ul className="mt-1 space-y-1">
            {runner.repos.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="text-muted">{p.defaultBranch}</span>
                {p.network && <Badge tone="warn">network on</Badge>}
                <span className="truncate text-xs text-muted">{p.remoteUrl}</span>
              </li>
            ))}
          </ul>
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
