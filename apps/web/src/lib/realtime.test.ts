import type { InstallationView, RunDetailView, RunView, WorkflowSummaryView } from "@sling/core";
import type { WorkflowDetailView } from "@sling/workflow";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  installations,
  run,
  runDetail,
  workflowDetail,
  workflowSummary,
} from "../test/fixtures.ts";
import { apply } from "./realtime.ts";
import { qk } from "./workflowApi.ts";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("workflow realtime events", () => {
  it("patches the list and the detail's summary fields on workflow.updated", () => {
    const qc = client();
    qc.setQueryData(qk.workflows(), [workflowSummary]);
    qc.setQueryData(qk.workflow("wf_1"), workflowDetail);
    apply(qc, {
      type: "workflow.updated",
      workflow: { ...workflowSummary, enabled: false, hasUnpublishedChanges: false },
    });
    expect(qc.getQueryData<WorkflowSummaryView[]>(qk.workflows())?.[0]?.enabled).toBe(false);
    const d = qc.getQueryData<WorkflowDetailView>(qk.workflow("wf_1"));
    expect(d?.enabled).toBe(false);
    expect(d?.hasUnpublishedChanges).toBe(false);
    expect(d?.draft).toBe(workflowDetail.draft);
  });

  it("doesn't create lists that were never fetched", () => {
    const qc = client();
    apply(qc, { type: "workflow.updated", workflow: workflowSummary });
    apply(qc, { type: "installation.updated", installation: installations[0] as InstallationView });
    expect(qc.getQueryData(qk.workflows())).toBeUndefined();
    expect(qc.getQueryData(qk.installations())).toBeUndefined();
  });

  it("adds new runs to the top and updates the workflow's last run", () => {
    const qc = client();
    qc.setQueryData(qk.runs("wf_1"), [run]);
    qc.setQueryData(qk.workflows(), [workflowSummary]);
    const next: RunView = {
      ...run,
      id: "run_2",
      status: "running",
      createdAt: "2026-11-05T11:00:00.000Z",
    };
    apply(qc, { type: "run.updated", run: next });
    expect(qc.getQueryData<RunView[]>(qk.runs("wf_1"))?.map((r) => r.id)).toEqual([
      "run_2",
      "run_1",
    ]);
    expect(qc.getQueryData<WorkflowSummaryView[]>(qk.workflows())?.[0]?.lastRun).toEqual({
      id: "run_2",
      status: "running",
      createdAt: "2026-11-05T11:00:00.000Z",
    });
  });

  it("updates a run's detail and its node runs", () => {
    const qc = client();
    qc.setQueryData(qk.run("run_1"), runDetail);
    apply(qc, { type: "run.updated", run: { ...run, status: "cancelled" } });
    const first = runDetail.nodeRuns[0];
    if (!first) throw new Error("fixture");
    apply(qc, { type: "node_run.updated", nodeRun: { ...first, status: "failed" } });
    apply(qc, {
      type: "node_run.updated",
      nodeRun: { ...first, id: "nr_9", nodeId: "n_extra", startedAt: "2026-11-05T10:01:00.000Z" },
    });
    const d = qc.getQueryData<RunDetailView>(qk.run("run_1"));
    expect(d?.run.status).toBe("cancelled");
    expect(d?.nodeRuns[0]?.status).toBe("failed");
    expect(d?.nodeRuns).toHaveLength(5);
  });

  it("upserts installations", () => {
    const qc = client();
    qc.setQueryData(qk.installations(), installations);
    const first = installations[0] as InstallationView;
    apply(qc, { type: "installation.updated", installation: { ...first, status: "error" } });
    expect(qc.getQueryData<InstallationView[]>(qk.installations())?.[0]?.status).toBe("error");
  });
});
