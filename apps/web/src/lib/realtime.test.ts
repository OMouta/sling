import type {
  ExtensionDetailView,
  ExtensionView,
  InstallationView,
  RunDetailView,
  RunnerView,
  RunView,
  SandboxListView,
  WorkflowSummaryView,
} from "@sling/core";
import type { WorkflowDetailView } from "@sling/workflow";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  acmeExtension,
  busySandbox,
  devbox,
  extensionList,
  installations,
  machineTask,
  ntfyDetail,
  ntfyExtension,
  run,
  runDetail,
  sandboxList,
  sandboxRunner,
  sandboxTask,
  waitingTask,
  workflowDetail,
  workflowSummary,
} from "../test/fixtures.ts";
import { apply } from "./realtime.ts";
import type { ConversationDetail, TaskDetail } from "./types.ts";
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

describe("sandbox realtime events", () => {
  function conversation(tasks: ConversationDetail["tasks"]): ConversationDetail {
    return {
      conversation: {
        id: "cnv_1",
        title: "Signup",
        mode: "supervised",
        settings: { assistant: null, agent: null },
        personalityId: null,
        startedBy: null,
        archived: false,
        createdAt: "2026-11-05T10:00:00.000Z",
        updatedAt: "2026-11-05T10:00:00.000Z",
      },
      personality: null,
      messages: [],
      tasks,
      agentStatus: "idle",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  it("patches the list and refetches usage when a sandbox changes state", () => {
    const qc = client();
    qc.setQueryData(qk.sandboxes(), sandboxList);
    apply(qc, { type: "sandbox.updated", sandbox: { ...busySandbox, state: "releasing" } });
    const d = qc.getQueryData<SandboxListView>(qk.sandboxes());
    expect(d?.sandboxes[0]?.state).toBe("releasing");
    expect(d?.sandboxes).toHaveLength(3);
    expect(qc.getQueryState(qk.sandboxes())?.isInvalidated).toBe(true);
  });

  it("adds new sandboxes to the top, and leaves usage alone for minute ticks", () => {
    const qc = client();
    qc.setQueryData(qk.sandboxes(), sandboxList);
    apply(qc, { type: "sandbox.updated", sandbox: { ...busySandbox, minutes: 5 } });
    expect(qc.getQueryState(qk.sandboxes())?.isInvalidated).toBe(false);
    apply(qc, {
      type: "sandbox.updated",
      sandbox: { ...busySandbox, id: "sbx_9", state: "requested", taskId: null },
    });
    const d = qc.getQueryData<SandboxListView>(qk.sandboxes());
    expect(d?.sandboxes.map((s) => s.id)).toEqual(["sbx_9", "sbx_1", "sbx_2", "sbx_3"]);
    expect(d?.sandboxes[1]?.minutes).toBe(5);
  });

  it("doesn't create a sandbox list that was never fetched", () => {
    const qc = client();
    apply(qc, { type: "sandbox.updated", sandbox: busySandbox });
    expect(qc.getQueryData(qk.sandboxes())).toBeUndefined();
  });

  it("shows the sandbox's state on its task", () => {
    const qc = client();
    const detail: TaskDetail = { task: { ...waitingTask, id: "tsk_sbx" }, events: [] };
    qc.setQueryData(["task", "tsk_sbx"], detail);
    qc.setQueryData(["conversation", "cnv_1"], conversation([machineTask, detail.task]));
    qc.setQueryData(["conversation", "cnv_2"], conversation([machineTask]));
    apply(qc, { type: "sandbox.updated", sandbox: { ...busySandbox, state: "provisioning" } });
    const expected = {
      kind: "sandbox",
      sandboxId: "sbx_1",
      sandboxState: "provisioning",
      providerName: "Docker host",
    };
    expect(qc.getQueryData<TaskDetail>(["task", "tsk_sbx"])?.task.environment).toEqual(expected);
    const c1 = qc.getQueryData<ConversationDetail>(["conversation", "cnv_1"]);
    expect(c1?.tasks[1]?.environment).toEqual(expected);
    expect(c1?.tasks[0]).toBe(machineTask);
    const c2 = qc.getQueryData<ConversationDetail>(["conversation", "cnv_2"]);
    expect(c2?.tasks[0]).toBe(machineTask);
  });

  it("ignores an older sandbox of a task that has moved on", () => {
    const qc = client();
    const task = {
      ...sandboxTask,
      environment: { ...sandboxTask.environment, sandboxId: "sbx_new" },
    };
    qc.setQueryData<TaskDetail>(["task", "tsk_sbx"], { task, events: [] });
    apply(qc, { type: "sandbox.updated", sandbox: { ...busySandbox, state: "destroyed" } });
    expect(qc.getQueryData<TaskDetail>(["task", "tsk_sbx"])?.task.environment.sandboxState).toBe(
      "busy",
    );
  });

  it("keeps sandbox Runners out of the machine list", () => {
    const qc = client();
    qc.setQueryData(["runners"], [devbox, { ...sandboxRunner, ephemeral: false }]);
    apply(qc, { type: "runner.updated", runner: sandboxRunner });
    apply(qc, { type: "runner.updated", runner: { ...sandboxRunner, id: "rnr_sbx2" } });
    expect(qc.getQueryData<RunnerView[]>(["runners"])?.map((r) => r.id)).toEqual(["rnr_1"]);
  });
});

describe("extension realtime events", () => {
  function seeded() {
    const qc = client();
    qc.setQueryData(qk.extensions(), extensionList);
    qc.setQueryData(qk.extension("ntfy"), ntfyDetail);
    for (const key of [qk.connectors(), qk.catalog(), qk.templates(), qk.discover()]) {
      qc.setQueryData(key, []);
    }
    return qc;
  }
  const invalidated = (qc: QueryClient, key: readonly unknown[]) =>
    qc.getQueryState(key)?.isInvalidated ?? false;

  it("patches only the extension when just its process status changes", () => {
    const qc = seeded();
    apply(qc, { type: "extension.updated", extension: { ...ntfyExtension, status: "stopped" } });
    const list = qc.getQueryData<ExtensionView[]>(qk.extensions());
    expect(list?.find((x) => x.id === "ntfy")?.status).toBe("stopped");
    expect(qc.getQueryData<ExtensionDetailView>(qk.extension("ntfy"))?.status).toBe("stopped");
    expect(qc.getQueryData<ExtensionDetailView>(qk.extension("ntfy"))?.readme).toBe(
      ntfyDetail.readme,
    );
    expect(invalidated(qc, qk.connectors())).toBe(false);
    expect(invalidated(qc, qk.discover())).toBe(false);
  });

  it("refetches what an extension adds when its version or state changes", () => {
    const qc = seeded();
    apply(qc, { type: "extension.updated", extension: { ...ntfyExtension, version: "1.1.0" } });
    for (const key of [qk.connectors(), qk.catalog(), qk.templates(), qk.discover()]) {
      expect(invalidated(qc, key)).toBe(true);
    }
    // A new version has a new README, digest, and version list.
    expect(invalidated(qc, qk.extension("ntfy"))).toBe(true);
  });

  it("refetches Discover when a catalog offers a new version", () => {
    const qc = seeded();
    apply(qc, {
      type: "extension.updated",
      extension: { ...ntfyExtension, update: { version: "1.2.0", catalogId: "included" } },
    });
    expect(invalidated(qc, qk.discover())).toBe(true);
    expect(invalidated(qc, qk.connectors())).toBe(false);
  });

  it("adds a new extension and drops a removed one with its details", () => {
    const qc = seeded();
    qc.setQueryData(qk.installations(), installations);
    apply(qc, { type: "extension.updated", extension: { ...acmeExtension, id: "pager" } });
    expect(qc.getQueryData<ExtensionView[]>(qk.extensions())?.map((x) => x.id)).toContain("pager");
    apply(qc, { type: "extension.removed", id: "ntfy" });
    expect(qc.getQueryData<ExtensionView[]>(qk.extensions())?.map((x) => x.id)).not.toContain(
      "ntfy",
    );
    expect(qc.getQueryData(qk.extension("ntfy"))).toBeUndefined();
    expect(invalidated(qc, qk.installations())).toBe(true);
    expect(invalidated(qc, qk.connectors())).toBe(true);
  });

  it("doesn't create a list that was never fetched", () => {
    const qc = client();
    apply(qc, { type: "extension.updated", extension: ntfyExtension });
    expect(qc.getQueryData(qk.extensions())).toBeUndefined();
  });
});
