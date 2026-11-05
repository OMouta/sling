import type { SandboxListView, SandboxView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Box, Trash2 } from "lucide-react";
import { useState } from "react";
import { Page, StatsBar, Toolbar, ToolbarText } from "../components/Page.tsx";
import { SandboxStateBadge } from "../components/StatusBadge.tsx";
import {
  Button,
  Card,
  cx,
  Dialog,
  Empty,
  ErrorText,
  Mono,
  Skeleton,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
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

  const [tab, setTab] = useState<"live" | "all">("all");
  const live = sandboxes.filter((x) => isLiveSandbox(x.state));
  const rows = tab === "live" ? live : sandboxes;
  const used = rows.reduce((n, x) => n + x.minutes, 0);

  return (
    <Page
      title="Sandboxes"
      badge={
        list.data && list.data.usage.running > 0 ? (
          <span className="tabular text-xs text-subtle">{list.data.usage.running} running</span>
        ) : undefined
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "all", label: "All sandboxes" },
            { id: "live", label: "Live", count: live.length },
          ]}
        />
      }
      toolbar={
        <Toolbar>
          <ToolbarText>
            Fresh environments a provider creates for one task, then destroys. Limits and secrets
            are under Settings.
          </ToolbarText>
        </Toolbar>
      }
      footer={
        rows.length > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-text">{rows.length}</span> sandboxes in view
              </>,
              <>
                <span className="text-text">{minutes(used)}</span> used
              </>,
            ]}
          />
        )
      }
    >
      {/* A column, so an empty list can center itself under the usage. */}
      <div className="flex min-h-full flex-col">
        <div className="px-5 pt-1 pb-5">
          {list.isPending && <Skeleton className="h-24 w-full rounded-xl" />}
          <ErrorText error={list.error} />
          {list.data && <Usage usage={list.data.usage} />}
        </div>
        {list.data && rows.length === 0 && (
          <Empty
            icon={Box}
            title={sandboxes.length === 0 ? "No sandboxes yet" : "Nothing live"}
            className="flex-1 justify-center pb-[12vh]"
          >
            {sandboxes.length === 0 ? (
              <>
                When no machine can take a task, Sling asks to run it in a sandbox. Add a provider
                under{" "}
                <Link to="/connectors" className="text-accent-text hover:underline">
                  Connectors
                </Link>
                .
              </>
            ) : (
              "No sandbox is running right now."
            )}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table className="border-t border-border">
            <thead>
              <tr>
                <Th>Task</Th>
                <Th>State</Th>
                <Th>Provider</Th>
                <Th>Image</Th>
                <Th align="right">Used</Th>
                <Th align="right">Time</Th>
                <Th align="right">Requested</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <SandboxRow
                  key={x.id}
                  sandbox={x}
                  connectorName={connectorName.get(x.connectorId) ?? x.connectorId}
                  now={now}
                />
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Page>
  );
}

function Usage({ usage }: { usage: SandboxListView["usage"] }) {
  const { monthMinutes, monthlyMinutesBudget: budget } = usage;
  const ratio = budget > 0 ? monthMinutes / budget : 1;
  const segments = 30;
  const filled = Math.min(segments, Math.round(ratio * segments));
  const tone = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warn" : "bg-accent-text";
  return (
    <Card className="grid gap-5 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end sm:gap-10">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-subtle">Minutes this month</span>
          <span className="tabular text-xs text-soft">
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
        <div aria-hidden="true" className="mt-2.5 flex gap-[3px]">
          {Array.from({ length: segments }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments of a meter.
              key={i}
              className={cx("h-3 flex-1 rounded-[2px]", i < filled ? tone : "bg-surface-3")}
            />
          ))}
        </div>
        {ratio >= 1 && (
          <p className="mt-2 text-xs text-danger">
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
      <p className="text-xs text-subtle">{label}</p>
      <p className="tabular mt-1 text-xl font-medium tracking-tight">{value}</p>
    </div>
  );
}

function SandboxRow({
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
    <Tr>
      <Td className="max-w-[340px]">
        <div className="min-w-0">
          {s.taskId ? (
            <Link
              to="/tasks/$id"
              params={{ id: s.taskId }}
              className="block truncate decoration-faint underline-offset-2 hover:underline"
            >
              {s.taskTitle ?? "Its task"}
            </Link>
          ) : (
            <span className="text-muted">No task yet</span>
          )}
          {s.failure && (
            <p className="truncate text-xs whitespace-normal text-danger">{s.failure}</p>
          )}
        </div>
      </Td>
      <Td>
        <SandboxStateBadge state={s.state} />
      </Td>
      <Td className="text-[13px]">
        <span className="text-soft">{s.providerName}</span>{" "}
        <span className="text-xs text-subtle">{connectorName}</span>
      </Td>
      <Td className="max-w-[220px]">
        <div className="min-w-0">
          <Mono className="block truncate">{s.image}</Mono>
          {s.externalId && (
            <code
              className="mt-0.5 block truncate font-mono text-[11px] text-subtle"
              title={`Provider ID: ${s.externalId}`}
            >
              {s.externalId}
            </code>
          )}
        </div>
      </Td>
      <Td align="right" className="text-[13px] text-soft">
        {minutes(s.minutes)}
      </Td>
      <Td align="right" className="text-[13px] text-soft">
        {live ? "Running for " : "Ran "}
        {duration(sandboxRunMs(s, now))}
      </Td>
      <Td align="right" className="text-[13px] text-muted">
        {ago(s.requestedAt, now)}
      </Td>
      <Td align="right">
        {s.state !== "destroyed" && (
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            aria-label={`Destroy the sandbox for ${s.taskTitle ?? s.id}`}
            onClick={() => setConfirm(true)}
          >
            Destroy
          </Button>
        )}
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
            <p className="text-left text-[13px] leading-5 whitespace-normal text-soft">
              {s.providerName} removes it now, with anything in it that wasn't pushed.
              {live && s.taskId ? " Its task stops and is marked interrupted." : ""}
            </p>
          </Dialog>
        )}
      </Td>
    </Tr>
  );
}
