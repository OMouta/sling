import type {
  ConnectorView,
  InstallationView,
  RunDetailView,
  RunView,
  WorkflowSummaryView,
} from "@sling/core";
import type {
  NodeCatalog,
  PublishResult,
  TemplateView,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowDetailView,
  WorkflowVersionView,
} from "@sling/workflow";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";

/**
 * React Query keys for workflows and connectors. Pages read these and
 * `realtime.ts` patches the same keys from server events:
 *
 *   ["workflows"]                       WorkflowSummaryView[]  GET /api/workflows
 *   ["workflow", id]                    WorkflowDetailView     GET /api/workflows/:id
 *   ["workflow-runs", workflowId]       RunView[]              GET /api/workflows/:id/runs
 *   ["workflow-versions", workflowId]   WorkflowVersionView[]  GET /api/workflows/:id/versions
 *   ["workflow-version", workflowId, n] WorkflowVersionView    GET /api/workflows/:id/versions/:n
 *   ["run", runId]                      RunDetailView          GET /api/runs/:id
 *   ["workflow-nodes"]                  NodeCatalog            GET /api/workflow-nodes
 *   ["templates"]                       TemplateView[]         GET /api/templates
 *   ["connectors"]                      ConnectorView[]        GET /api/connectors
 *   ["installations"]                   InstallationView[]     GET /api/installations
 *
 * Runs and versions have their own roots so invalidating a workflow's detail
 * doesn't refetch its run list.
 */
export const qk = {
  workflows: () => ["workflows"] as const,
  workflow: (id: string) => ["workflow", id] as const,
  runs: (workflowId: string) => ["workflow-runs", workflowId] as const,
  versions: (workflowId: string) => ["workflow-versions", workflowId] as const,
  version: (workflowId: string, n: number) => ["workflow-version", workflowId, n] as const,
  run: (runId: string) => ["run", runId] as const,
  catalog: () => ["workflow-nodes"] as const,
  templates: () => ["templates"] as const,
  connectors: () => ["connectors"] as const,
  installations: () => ["installations"] as const,
};

export function useWorkflows() {
  return useQuery({
    queryKey: qk.workflows(),
    queryFn: () => api.get<WorkflowSummaryView[]>("/api/workflows"),
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    queryKey: qk.workflow(id),
    queryFn: () => api.get<WorkflowDetailView>(`/api/workflows/${id}`),
  });
}

/** The raw catalog. The canvas wants `useCatalogIndex` from `workflow/catalogIndex.ts`. */
export function useCatalog() {
  return useQuery({
    queryKey: qk.catalog(),
    queryFn: () => api.get<NodeCatalog>("/api/workflow-nodes"),
    staleTime: 5 * 60_000,
  });
}

export function useRuns(workflowId: string) {
  return useQuery({
    queryKey: qk.runs(workflowId),
    queryFn: () => api.get<RunView[]>(`/api/workflows/${workflowId}/runs`),
  });
}

export function useRun(runId: string | null) {
  return useQuery({
    queryKey: qk.run(runId ?? ""),
    queryFn: () => api.get<RunDetailView>(`/api/runs/${runId}`),
    enabled: runId !== null,
  });
}

export function useVersions(workflowId: string) {
  return useQuery({
    queryKey: qk.versions(workflowId),
    queryFn: () => api.get<WorkflowVersionView[]>(`/api/workflows/${workflowId}/versions`),
  });
}

export function useVersion(workflowId: string, n: number | null) {
  return useQuery({
    queryKey: qk.version(workflowId, n ?? 0),
    queryFn: () => api.get<WorkflowVersionView>(`/api/workflows/${workflowId}/versions/${n}`),
    enabled: n !== null,
    // Versions never change.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: qk.templates(),
    queryFn: () => api.get<TemplateView[]>("/api/templates"),
    enabled,
  });
}

export function useConnectors() {
  return useQuery({
    queryKey: qk.connectors(),
    queryFn: () => api.get<ConnectorView[]>("/api/connectors"),
    staleTime: 5 * 60_000,
  });
}

export function useInstallations() {
  return useQuery({
    queryKey: qk.installations(),
    queryFn: () => api.get<InstallationView[]>("/api/installations"),
  });
}

/** The run a request created. Accepts a bare RunView or `{ run }`. */
export function runIdOf(res: RunView | { run: RunView } | { id: string }): string {
  return "run" in res ? res.run.id : res.id;
}

/** The workflow a request created. Accepts a detail or summary view, or `{ workflow }`. */
export function workflowIdOf(res: { id: string } | { workflow: { id: string } }): string {
  return "workflow" in res ? res.workflow.id : res.id;
}

/** `POST /validate` answers with issues, either bare or as `{ issues }`. */
export function issuesOf(
  res: ValidationIssue[] | { issues?: ValidationIssue[] } | null,
): ValidationIssue[] {
  if (Array.isArray(res)) return res;
  return res?.issues ?? [];
}

export const workflowApi = {
  saveDraft: (id: string, def: WorkflowDefinition) =>
    api.put<unknown>(`/api/workflows/${id}/draft`, def),
  validate: (id: string) =>
    api
      .post<ValidationIssue[] | { issues?: ValidationIssue[] }>(`/api/workflows/${id}/validate`)
      .then(issuesOf),
  /** A draft that fails validation comes back as 422 with the issues in the body. */
  publish: async (id: string, note: string): Promise<PublishResult> => {
    try {
      return await api.post<PublishResult>(`/api/workflows/${id}/publish`, { note });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && isPublishResult(err.body)) {
        return err.body;
      }
      throw err;
    }
  },
  run: (id: string, input: unknown) =>
    api.post<RunView | { run: RunView }>(`/api/workflows/${id}/run`, { input }).then(runIdOf),
  patch: (id: string, body: { name?: string; description?: string; enabled?: boolean }) =>
    api.patch<WorkflowSummaryView | WorkflowDetailView>(`/api/workflows/${id}`, body),
};

/** Strips characters file systems reject, for `<name>.workflow.json`. */
export function exportFileName(name: string): string {
  const printable = [...name].filter((ch) => ch.charCodeAt(0) >= 32).join("");
  const safe = printable.replace(/[/\\:*?"<>|]+/g, "-").trim() || "workflow";
  return `${safe}.workflow.json`;
}

export function downloadJson(fileName: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isPublishResult(value: unknown): value is PublishResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray((value as { issues: unknown }).issues)
  );
}
