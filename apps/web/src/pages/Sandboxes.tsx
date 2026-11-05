import type { SandboxListView, SandboxView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SandboxStateBadge } from "../components/StatusBadge.tsx";
import {
  Button,
  Card,
  cx,
  Dialog,
  Empty,
  ErrorText,
  PageHeader,
  Spinner,
} from "../components/ui.tsx";
import { ago, duration } from "../lib/format.ts";
import { isLiveSandbox, minutes, money, sandboxRunMs } from "../lib/sandbox.ts";
import { isSandboxView, sandboxApi, useSandboxes } from "../lib/sandboxApi.ts";
import { useNow } from "../lib/useNow.ts";
import { qk, useConnectors } from "../lib/workflowApi.ts";

export function SandboxesPage() {
  const list = useSandboxes();
  const connectors = useConnectors();
  const sandboxes = list.data?.sandboxes ?? [];
  const now = useNow(
    1000,
    sandboxes.some((s) => isLiveSandbox(s.state)),
  );
  const connectorName = new Map((connectors.data ?? []).map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <PageHeader
        title="Sandboxes"
        description="Fresh environments a provider creates for one task, then destroys. Limits and secrets are under Settings."
      />
      {list.isPending && <Spinner />}
      <ErrorText error={list.error} />
      {list.data && <Usage usage={list.data.usage} />}
      {list.data && sandboxes.length === 0 && (
        <Empty title="No sandboxes yet">
          When no machine can take a task, Sling asks to run it in a sandbox. Add a provider under{" "}
          <Link to="/connectors" className="text-accent hover:underline">
            Connectors
          </Link>
          .
        </Empty>
      )}
      <ul className="space-y-3">
        {sandboxes.map((s) => (
          <SandboxCard
            key={s.id}
            sandbox={s}
            connectorName={connectorName.get(s.connectorId) ?? s.connectorId}
            now={now}
          />
        ))}
      </ul>
    </div>
  );
}

function Usage({ usage }: { usage: SandboxListView["usage"] }) {
  const { monthMinutes, monthlyMinutesBudget: budget } = usage;
  const ratio = budget > 0 ? monthMinutes / budget : 1;
  const tone = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <Card className="grid gap-4 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end sm:gap-8">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Minutes this month</span>
          <span className="text-muted">
            {minutes(monthMinutes)} of {minutes(budget)}
          </span>
        </div>
        {/* The native meter is for assistive tech; browsers style it too differently to show. */}
        <meter
          className="sr-only"
          aria-label="Sandbox minutes this month"
          min={0}
          max={budget}
          value={Math.min(monthMinutes, budget)}
          aria-valuetext={`${minutes(monthMinutes)} of ${minutes(budget)}`}
        />
        <div aria-hidden="true" className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cx("h-full rounded-full transition-[width]", tone)}
            style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
          />
        </div>
        {ratio >= 1 && (
          <p className="mt-1.5 text-xs text-danger">
            The budget is used up. New sandboxes are refused until next month, or until you raise it
            in Settings.
          </p>
        )}
      </div>
      <Stat label="Running" value={`${usage.running} of ${usage.concurrentLimit}`} />
      {usage.estimatedMonthCost !== null && (
        <Stat
          label="Estimated spend"
          value={money(usage.estimatedMonthCost)}
          hint="This month, from each provider's cost per hour"
        />
      )}
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SandboxCard({
  sandbox: s,
  connectorName,
  now,
}: {
  sandbox: SandboxView;
  connectorName: string;
  now: number;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const live = isLiveSandbox(s.state);
  const destroy = useMutation({
    mutationFn: () => sandboxApi.destroy(s.id),
    onSuccess: (res) => {
      if (isSandboxView(res)) {
        qc.setQueryData<SandboxListView>(qk.sandboxes(), (d) =>
          d ? { ...d, sandboxes: d.sandboxes.map((x) => (x.id === res.id ? res : x)) } : d,
        );
      }
      void qc.invalidateQueries({ queryKey: qk.sandboxes() });
      setConfirm(false);
    },
  });

  return (
    <li>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SandboxStateBadge state={s.state} />
          <span className="font-medium">{s.providerName}</span>
          <span className="text-sm text-muted">{connectorName}</span>
          <span className="ml-auto text-sm text-muted tabular-nums">
            {live ? "Running for " : "Ran "}
            {duration(sandboxRunMs(s, now))}
          </span>
        </div>
        <p className="text-sm">
          {s.taskId ? (
            <Link
              to="/tasks/$id"
              params={{ id: s.taskId }}
              className="hover:underline hover:underline-offset-2"
            >
              {s.taskTitle ?? "Its task"}
            </Link>
          ) : (
            <span className="text-muted">No task yet</span>
          )}
        </p>
        <p className="text-xs text-muted">
          <code className="font-mono">{s.image}</code> · {minutes(s.minutes)} used · requested{" "}
          {ago(s.requestedAt, now)}
        </p>
        {s.failure && <p className="text-sm text-danger">{s.failure}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {s.externalId && (
            <code
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
              title={`Provider ID: ${s.externalId}`}
            >
              {s.externalId}
            </code>
          )}
          {s.state !== "destroyed" && (
            <Button
              size="sm"
              variant="danger"
              className="ml-auto"
              aria-label={`Destroy the sandbox for ${s.taskTitle ?? s.id}`}
              onClick={() => setConfirm(true)}
            >
              Destroy
            </Button>
          )}
        </div>
      </Card>
      {confirm && (
        <Dialog
          title="Destroy this sandbox?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <ErrorText error={destroy.error} />
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" busy={destroy.isPending} onClick={() => destroy.mutate()}>
                Destroy
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {s.providerName} removes it now, with anything in it that wasn't pushed.
            {live && s.taskId ? " Its task stops and is marked interrupted." : ""}
          </p>
        </Dialog>
      )}
    </li>
  );
}
