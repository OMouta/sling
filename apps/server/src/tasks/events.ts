import type { TaskEventType, TaskState } from "@sling/core";
import {
  ActionRequest_Kind,
  ActionResult_Outcome,
  CommandRun_Status,
  FileChange_Kind,
  LogLine_Stream,
  type TaskEvent,
  TaskFinished_Outcome,
  TaskRejected_Reason,
} from "@sling/runner-protocol";

/** A task event as stored in Postgres and shown in the timeline. */
export interface StoredEvent {
  type: TaskEventType;
  payload: Record<string, unknown>;
}

const COMMAND_STATUS: Record<number, string> = {
  [CommandRun_Status.STARTED]: "started",
  [CommandRun_Status.COMPLETED]: "completed",
  [CommandRun_Status.FAILED]: "failed",
};

const FILE_KIND: Record<number, string> = {
  [FileChange_Kind.ADD]: "add",
  [FileChange_Kind.MODIFY]: "modify",
  [FileChange_Kind.DELETE]: "delete",
};

const REJECT_REASON: Record<number, string> = {
  [TaskRejected_Reason.MODE_ABOVE_CAP]: "mode_above_cap",
  [TaskRejected_Reason.UNKNOWN_REPO]: "unknown_repo",
  [TaskRejected_Reason.HARNESS_UNAVAILABLE]: "harness_unavailable",
  [TaskRejected_Reason.BUSY]: "busy",
  [TaskRejected_Reason.INVALID]: "invalid",
};

export const FINISHED_STATE: Record<number, TaskState> = {
  [TaskFinished_Outcome.SUCCEEDED]: "succeeded",
  [TaskFinished_Outcome.FAILED]: "failed",
  [TaskFinished_Outcome.CANCELLED]: "cancelled",
  [TaskFinished_Outcome.INTERRUPTED]: "interrupted",
};

export const ACTION_OUTCOME: Record<number, "succeeded" | "failed" | "refused"> = {
  [ActionResult_Outcome.SUCCEEDED]: "succeeded",
  [ActionResult_Outcome.FAILED]: "failed",
  [ActionResult_Outcome.REFUSED]: "refused",
};

export const ACTION_KIND_TO_PROTO = {
  push: ActionRequest_Kind.PUSH,
  open_pr: ActionRequest_Kind.OPEN_PR,
} as const;

/** Converts a protobuf event into the JSON shape the web app reads. */
export function toStoredEvent(ev: TaskEvent): StoredEvent | null {
  const k = ev.kind;
  switch (k.case) {
    case "accepted":
      return { type: "accepted", payload: {} };
    case "rejected":
      return {
        type: "rejected",
        payload: { reason: REJECT_REASON[k.value.reason] ?? "unknown", message: k.value.message },
      };
    case "started":
      return {
        type: "started",
        payload: {
          branch: k.value.branch,
          baseSha: k.value.baseSha,
          worktreePath: k.value.worktreePath,
          harness: k.value.harness,
          harnessVersion: k.value.harnessVersion,
        },
      };
    case "agentMessage":
      return { type: "agent_message", payload: { itemId: k.value.itemId, text: k.value.text } };
    case "command":
      return {
        type: "command",
        payload: {
          itemId: k.value.itemId,
          command: k.value.command,
          status: COMMAND_STATUS[k.value.status] ?? "started",
          exitCode: k.value.exitCode ?? null,
          output: k.value.output,
        },
      };
    case "fileChange":
      return {
        type: "file_change",
        payload: {
          itemId: k.value.itemId,
          changes: k.value.changes.map((c) => ({
            path: c.path,
            kind: FILE_KIND[c.kind] ?? "modify",
          })),
        },
      };
    case "plan":
      return {
        type: "plan",
        payload: { steps: k.value.steps.map((s) => ({ text: s.text, done: s.done })) },
      };
    case "log":
      return {
        type: "log",
        payload: {
          stream: k.value.stream === LogLine_Stream.HARNESS_STDERR ? "harness_stderr" : "runner",
          text: k.value.text,
        },
      };
    case "usage":
      return {
        type: "usage",
        payload: {
          inputTokens: Number(k.value.inputTokens),
          cachedInputTokens: Number(k.value.cachedInputTokens),
          outputTokens: Number(k.value.outputTokens),
        },
      };
    case "finished":
      return {
        type: "finished",
        payload: {
          outcome: FINISHED_STATE[k.value.outcome] ?? "failed",
          summary: k.value.summary,
          error: k.value.error,
          branch: k.value.branch,
          commitSha: k.value.commitSha,
          diffStats: k.value.diffStats
            ? {
                filesChanged: k.value.diffStats.filesChanged,
                insertions: k.value.diffStats.insertions,
                deletions: k.value.diffStats.deletions,
              }
            : null,
        },
      };
    case "actionResult":
      return {
        type: "action_result",
        payload: {
          actionId: k.value.actionId,
          kind: k.value.kind === ActionRequest_Kind.OPEN_PR ? "open_pr" : "push",
          outcome: ACTION_OUTCOME[k.value.outcome] ?? "failed",
          message: k.value.message,
          url: k.value.url,
        },
      };
    default:
      return null;
  }
}

/** Event types that may be dropped once a task passes its storage cap. */
export const DROPPABLE: ReadonlySet<TaskEventType> = new Set([
  "log",
  "command",
  "agent_message",
  "file_change",
  "plan",
]);
