import type { InstallationView, WorkflowSummaryView } from "@sling/core";
import type { TemplateView, WorkflowDetailView } from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, LayoutTemplate, Plus, Upload, Workflow, Zap } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Page, StatsBar, Toolbar } from "../components/Page.tsx";
import { RunStatusBadge } from "../components/StatusBadge.tsx";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import {
  qk,
  useCatalog,
  useInstallations,
  useTemplates,
  useWorkflows,
  workflowApi,
  workflowIdOf,
} from "../lib/workflowApi.ts";

type Created = WorkflowDetailView | WorkflowSummaryView | { workflow: { id: string } };

export function WorkflowsPage() {
  const workflows = useWorkflows();
  const [dialog, setDialog] = useState<"blank" | "template" | null>(null);
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

  const [tab, setTab] = useState<"all" | "on" | "off">("all");
  const all = [...(workflows.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const enabled = all.filter((w) => w.enabled).length;
  const sorted = all.filter((w) => tab === "all" || (tab === "on") === w.enabled);
  const failing = all.filter((w) => w.lastRun?.status === "failed").length;

  return (
    <Page
      title="Workflows"
      badge={
        all.length > 0 ? (
          <Badge tone={enabled > 0 ? "ok" : "neutral"} dot>
            {enabled} on
          </Badge>
        ) : undefined
      }
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
              <Button icon={LayoutTemplate} onClick={() => setDialog("template")}>
                From template
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setDialog("blank")}>
                New workflow
              </Button>
            </>
          }
        >
          <p className="min-w-0 text-xs leading-4 text-muted max-lg:hidden">
            What Sling does when something happens: a chat message, an email, a schedule.
          </p>
          <ErrorText error={importJson.error} />
        </Toolbar>
      }
      footer={
        all.length > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-text">{sorted.length}</span> workflows in view
              </>,
              <>
                <span className="text-text">{enabled}</span> on
              </>,
              failing > 0 && (
                <>
                  <span className="text-danger">{failing}</span> failed last run
                </>
              ),
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
            <Button icon={LayoutTemplate} onClick={() => setDialog("template")}>
              Browse templates
            </Button>
          }
        >
          Start from a template or a blank canvas.
        </Empty>
      )}
      {sorted.length > 0 && (
        <Table className="border-t border-border">
          <thead>
            <tr>
              <Th>Workflow</Th>
              <Th>Trigger</Th>
              <Th>Version</Th>
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
      {dialog === "blank" && <NewBlankDialog onClose={() => setDialog(null)} />}
      {dialog === "template" && <TemplateDialog onClose={() => setDialog(null)} />}
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
      <Td className="max-w-[360px]">
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
      <Td className="max-w-[240px]">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-soft">
          <Zap aria-hidden="true" size={12} className="shrink-0 text-subtle" />
          <span className="truncate">{triggers ? `On ${triggers}` : "No trigger"}</span>
        </span>
      </Td>
      <Td>
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
            <span className="text-xs text-subtle group-hover/run:text-soft">
              {ago(w.lastRun.createdAt)}
            </span>
            <ChevronRight aria-hidden="true" size={12} className="text-faint" />
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

function NewBlankDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<Created>("/api/workflows", { name: name.trim() }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.workflows() });
      void navigate({ to: "/workflows/$id", params: { id: workflowIdOf(res) } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Dialog
      title="New workflow"
      onClose={onClose}
      footer={
        <>
          <ErrorText error={create.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="new-workflow"
            busy={create.isPending}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </>
      }
    >
      <form id="new-workflow" onSubmit={submit}>
        <Field label="Name">
          <Input
            value={name}
            maxLength={120}
            placeholder="Website health monitor"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const templates = useTemplates();
  const [picked, setPicked] = useState<TemplateView | null>(null);
  return (
    <Dialog
      title={picked ? picked.name : "New from template"}
      onClose={onClose}
      footer={
        picked ? undefined : (
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
        )
      }
    >
      {picked ? (
        <TemplateBindings template={picked} onBack={() => setPicked(null)} onClose={onClose} />
      ) : (
        <>
          {templates.isPending && <Spinner />}
          <ErrorText error={templates.error} />
          {templates.data?.length === 0 && <p className="text-[13px] text-muted">No templates.</p>}
          <ul className="space-y-2">
            {templates.data?.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => setPicked(t)}
                  className="pressable group flex w-full cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-3 text-left shadow-raised hover:shadow-raised-hover"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-icon">
                    <LayoutTemplate aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      {t.name}
                      {t.builtIn && <Badge>built in</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted">
                      {t.description}
                    </span>
                    {t.bindings.length > 0 && (
                      <span className="mt-1.5 block text-xs text-subtle">
                        Needs {t.bindings.map((b) => b.label).join(", ")}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-2 shrink-0 text-faint transition-colors duration-150 group-hover:text-soft"
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

function TemplateBindings({
  template,
  onBack,
  onClose,
}: {
  template: TemplateView;
  onBack: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const installations = useInstallations();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const options = (connectorId: string) =>
    (installations.data ?? []).filter((i: InstallationView) => i.connectorId === connectorId);

  // Preselect the only installation for a binding.
  const value = (placeholder: string, connectorId: string) => {
    const set = bindings[placeholder];
    if (set !== undefined) return set;
    const only = options(connectorId);
    return only.length === 1 && only[0] ? only[0].id : "";
  };
  const complete = template.bindings.every((b) => value(b.placeholder, b.connectorId));

  const create = useMutation({
    mutationFn: () =>
      api.post<Created>("/api/workflows", {
        templateKey: template.key,
        bindings: Object.fromEntries(
          template.bindings.map((b) => [b.placeholder, value(b.placeholder, b.connectorId)]),
        ),
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.workflows() });
      onClose();
      void navigate({ to: "/workflows/$id", params: { id: workflowIdOf(res) } });
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-5 text-muted">{template.description}</p>
      {installations.isPending && <Spinner />}
      {template.bindings.map((b) => {
        const list = options(b.connectorId);
        return (
          <Field key={b.placeholder} label={b.label}>
            {list.length === 0 ? (
              <span className="block rounded-lg bg-surface-2 p-3 text-xs text-muted shadow-raised">
                No {b.connectorId} installation yet.{" "}
                <Link
                  to="/connectors"
                  className="text-accent-text hover:underline"
                  onClick={onClose}
                >
                  Add one under Connectors
                </Link>
                .
              </span>
            ) : (
              <Select
                value={value(b.placeholder, b.connectorId)}
                onChange={(e) => setBindings((s) => ({ ...s, [b.placeholder]: e.target.value }))}
              >
                <option value="">Choose an installation</option>
                {list.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        );
      })}
      <ErrorText error={create.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          busy={create.isPending}
          disabled={!complete}
          onClick={() => create.mutate()}
        >
          Create workflow
        </Button>
      </div>
    </div>
  );
}
