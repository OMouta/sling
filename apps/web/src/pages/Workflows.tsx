import type { InstallationView, WorkflowSummaryView } from "@sling/core";
import type { TemplateView, WorkflowDetailView } from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { RunStatusBadge } from "../components/StatusBadge.tsx";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Switch,
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

  const sorted = [...(workflows.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <PageHeader
        title="Workflows"
        description="What Sling does when something happens: a chat message, an email, a schedule."
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
            <Button busy={importJson.isPending} onClick={() => file.current?.click()}>
              Import
            </Button>
            <Button onClick={() => setDialog("template")}>From template</Button>
            <Button variant="primary" onClick={() => setDialog("blank")}>
              New workflow
            </Button>
          </>
        }
      />
      <ErrorText error={importJson.error} />
      {workflows.isPending && <Spinner />}
      <ErrorText error={workflows.error} />
      {workflows.data?.length === 0 && (
        <Empty title="No workflows yet">Start from a template or a blank canvas.</Empty>
      )}
      {sorted.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {sorted.map((w) => (
            <WorkflowRow key={w.id} workflow={w} />
          ))}
        </ul>
      )}
      {dialog === "blank" && <NewBlankDialog onClose={() => setDialog(null)} />}
      {dialog === "template" && <TemplateDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function WorkflowRow({ workflow: w }: { workflow: WorkflowSummaryView }) {
  const qc = useQueryClient();
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/workflows/$id"
            params={{ id: w.id }}
            className="truncate font-medium hover:underline"
          >
            {w.name}
          </Link>
          {w.activeVersion === null ? (
            <Badge>Not published</Badge>
          ) : (
            <span className="text-xs text-muted">v{w.activeVersion}</span>
          )}
          {w.hasUnpublishedChanges && <Badge tone="warn">Unpublished changes</Badge>}
        </div>
        <p className="mt-0.5 truncate text-sm text-muted">
          {triggers ? `On ${triggers}` : "No trigger"}
        </p>
        <ErrorText error={toggle.error} />
      </div>
      <div className="flex items-center gap-2 text-sm">
        {w.lastRun ? (
          <Link
            to="/workflows/$id/runs/$runId"
            params={{ id: w.id, runId: w.lastRun.id }}
            className="flex items-center gap-2 hover:underline"
            title="Last run"
          >
            <RunStatusBadge status={w.lastRun.status} />
            <span className="text-xs text-muted">{ago(w.lastRun.createdAt)}</span>
          </Link>
        ) : (
          <span className="text-xs text-muted">Never run</span>
        )}
      </div>
      <Switch
        checked={w.enabled}
        label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`}
        disabled={toggle.isPending}
        onChange={(enabled) => toggle.mutate(enabled)}
      />
    </li>
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
          {templates.data?.length === 0 && <p className="text-sm text-muted">No templates.</p>}
          <ul className="space-y-2">
            {templates.data?.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  onClick={() => setPicked(t)}
                  className="w-full rounded-xl border border-border p-3 text-left hover:border-accent"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {t.name}
                    {t.builtIn && <Badge>built in</Badge>}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">{t.description}</span>
                  {t.bindings.length > 0 && (
                    <span className="mt-1 block text-xs text-muted">
                      Needs {t.bindings.map((b) => b.label).join(", ")}
                    </span>
                  )}
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
      <p className="text-sm text-muted">{template.description}</p>
      {installations.isPending && <Spinner />}
      {template.bindings.map((b) => {
        const list = options(b.connectorId);
        return (
          <Field key={b.placeholder} label={b.label}>
            {list.length === 0 ? (
              <span className="block rounded-lg border border-dashed border-border p-3 text-sm text-muted">
                No {b.connectorId} installation yet.{" "}
                <Link to="/connectors" className="text-accent hover:underline" onClick={onClose}>
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
