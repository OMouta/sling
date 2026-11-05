import type { ApprovalView } from "@sling/core";
import { describe, expect, it } from "vitest";
import { decisionCount, groupApprovals } from "./approvals.ts";

const base = {
  title: "",
  payload: null,
  runId: null,
  expiresAt: "2026-11-06T10:00:00.000Z",
  createdAt: "2026-11-05T10:00:00.000Z",
} as unknown as ApprovalView;

const push = {
  ...base,
  id: "a1",
  kind: "task_action",
  taskId: "t1",
  actionKind: "push",
} as ApprovalView;
const pr = {
  ...base,
  id: "a2",
  kind: "task_action",
  taskId: "t1",
  actionKind: "open_pr",
} as ApprovalView;
const other = {
  ...base,
  id: "a3",
  kind: "task_action",
  taskId: "t2",
  actionKind: "push",
} as ApprovalView;
const step = { ...base, id: "a4", kind: "workflow", taskId: null } as ApprovalView;
const sandbox = { ...base, id: "a5", kind: "sandbox_fallback", taskId: "t3" } as ApprovalView;

describe("approval decisions", () => {
  it("counts a task's push and pull request as one decision", () => {
    expect(decisionCount([push, pr])).toBe(1);
    expect(decisionCount([push, pr, other])).toBe(2);
  });

  it("counts each workflow step and sandbox request on its own", () => {
    const g = groupApprovals([push, pr, step, sandbox]);
    expect(g.byTask.get("t1")).toEqual([push, pr]);
    expect(g.workflow).toEqual([step]);
    expect(g.fallback).toEqual([sandbox]);
    expect(g.decisions).toBe(3);
  });

  it("is zero before approvals load", () => {
    expect(decisionCount(undefined)).toBe(0);
  });
});
