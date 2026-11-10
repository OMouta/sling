import type { WorkflowSummaryView } from "@sling/core";
import type { WorkflowDetailView } from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Plus, Upload, Workflow, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { Page, StatsBar, Toolbar } from "../components/Page.tsx";
import { RunStatusBadge } from "../components/StatusBadge.tsx";
import {
  Badge,
  Button,
  Empty,
  ErrorText,
  Skeleton,
  Switch,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
} from "../components/ui.tsx";
import { NewWorkflowDialog } from "../components/workflow/NewWorkflowDialog.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { qk, useCatalog, useWorkflows, workflowApi, workflowIdOf } from "../lib/workflowApi.ts";
import { workflowsRoute } from "../router.tsx";

type Created = WorkflowDetailView | WorkflowSummaryView | { workflow: { id: string } };

export function WorkflowsPage() {
  const workflows = useWorkflows();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);

  const importJson = useMutation({
    mutationFn: async (f: File) => {
      let body: unknown;
      try {
        body = JSON.parse(await f.text());
      } catch {
        throw new Error(`${f.name} isn't valid JSON.`);
      }
      return api.post<Created>("/api/workflows/import", body);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.workflows() });
      void navigate({ to: "/workflows/$id", params: { id: workflowIdOf(res) } });
    },
  });

  // In the URL, so Back from a workflow returns to the same tab.
  const tab = workflowsRoute.useSearch().tab ?? "all";
  const setTab = (t: "all" | "on" | "off") =>
    void navigate({ to: "/workflows", search: t === "all" ? {} : { tab: t }, replace: true });
  const all = [...(workflows.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const enabled = all.filter((w) => w.enabled).length;
  const sorted = all.filter((w) => tab === "all" || (tab === "on") === w.enabled);
  const failing = all.filter((w) => w.lastRun?.status === "failed").length;

  return (
    <Page
      title="Workflows"
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "all", label: "All workflows" },
            { id: "on", label: "On", count: enabled },
            { id: "off", label: "Off", count: all.length - enabled },
          ]}
        />
      }
      toolbar={
        <Toolbar
          actions={
            <>
              <input
                ref={file}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="Import workflow file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importJson.mutate(f);
                  e.target.value = "";
                }}
              />
              <Button
                icon={Upload}
                busy={importJson.isPending}
                onClick={() => file.current?.click()}
              >
                Import
              </Button>
              {workflows.data?.length !== 0 && (
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  New workflow
                </Button>
              )}
            </>
          }
        >
          <ErrorText error={importJson.error} />
        </Toolbar>
      }
      footer={
        failing > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-danger">{failing}</span> failed last run
              </>,
            ]}
          />
        )
      }
    >
      {workflows.isPending && (
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      )}
      <ErrorText error={workflows.error} />
      {workflows.data?.length === 0 && (
        <Empty
          fill
          icon={Workflow}
          title="No workflows yet"
          action={
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New workflow
            </Button>
          }
        />
      )}
      {sorted.length > 0 && (
        <Table className="border-t border-border">
          <thead>
            <tr>
              <Th>Workflow</Th>
              {/* A phone keeps the name, the last run and the switch. */}
              <Th className="max-sm:hidden">Trigger</Th>
              <Th className="max-sm:hidden">Version</Th>
              <Th>Last run</Th>
              <Th align="right">On</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((w) => (
              <WorkflowRow key={w.id} workflow={w} />
            ))}
          </tbody>
        </Table>
      )}
      {creating && <NewWorkflowDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}

function WorkflowRow({ workflow: w }: { workflow: WorkflowSummaryView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => workflowApi.patch(w.id, { enabled }),
    onMutate: (enabled) => {
      qc.setQueryData<WorkflowSummaryView[]>(qk.workflows(), (list) =>
        list?.map((x) => (x.id === w.id ? { ...x, enabled } : x)),
      );
    },
    onError: () => void qc.invalidateQueries({ queryKey: qk.workflows() }),
  });
  const triggers = w.triggers
    .map((t) => t.label || catalog.data?.nodes.find((n) => n.type === t.type)?.title || t.type)
    .join(", ");

  return (
    <Tr onClick={() => void navigate({ to: "/workflows/$id", params: { id: w.id } })}>
      <Td className="max-w-[360px] max-sm:w-full max-sm:max-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-icon shadow-raised">
            <Workflow aria-hidden="true" size={12} />
          </span>
          <div className="min-w-0">
            <Link
              to="/workflows/$id"
              params={{ id: w.id }}
              onClick={(e) => e.stopPropagation()}
              title={w.description || undefined}
              className="block truncate"
            >
              {w.name}
            </Link>
            <ErrorText error={toggle.error} />
          </div>
        </div>
      </Td>
      <Td className="max-w-[240px] max-sm:hidden">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-soft">
          <Zap aria-hidden="true" size={12} className="shrink-0 text-subtle" />
          <span className="truncate">{triggers ? `On ${triggers}` : "No trigger"}</span>
        </span>
      </Td>
      <Td className="max-sm:hidden">
        <span className="flex items-center gap-1.5">
          {w.activeVersion === null ? (
            <Badge>Not published</Badge>
          ) : (
            <span className="tabular text-[13px] text-soft">v{w.activeVersion}</span>
          )}
          {w.hasUnpublishedChanges && <Badge tone="warn">Unpublished changes</Badge>}
        </span>
      </Td>
      <Td>
        {w.lastRun ? (
          <Link
            to="/workflows/$id/runs/$runId"
            params={{ id: w.id, runId: w.lastRun.id }}
            onClick={(e) => e.stopPropagation()}
            className="group/run inline-flex items-center gap-2"
            title="Last run"
          >
            <RunStatusBadge status={w.lastRun.status} />
            <span className="text-xs text-subtle group-hover/run:text-soft max-sm:hidden">
              {ago(w.lastRun.createdAt)}
            </span>
            <ChevronRight aria-hidden="true" size={12} className="text-faint max-sm:hidden" />
          </Link>
        ) : (
          <span className="text-xs text-subtle">Never run</span>
        )}
      </Td>
      <Td align="right">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the row's click, the switch handles keys. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
        <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
          <Switch
            size="sm"
            checked={w.enabled}
            label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`}
            disabled={toggle.isPending}
            onChange={(enabled) => toggle.mutate(enabled)}
          />
        </span>
      </Td>
    </Tr>
  );
}
