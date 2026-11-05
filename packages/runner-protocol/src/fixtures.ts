import { create } from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  PermissionMode,
  TaskFinished_Outcome,
} from "../gen/sling/runner/v1/runner_pb.js";

/**
 * Messages shared with the Rust tests in crates/runner-protocol. Both sides must
 * encode these to the same bytes. Regenerate with `pnpm fixtures`.
 */
export const fixtures = {
  hello: create(EnvelopeSchema, {
    body: {
      case: "hello",
      value: {
        runnerId: "rnr_01",
        timestampMs: 1_767_225_600_000n,
        signature: new Uint8Array([1, 2, 3, 4]),
        runnerVersion: "0.1.0",
        os: "macos",
        arch: "aarch64",
        hostname: "devbox",
        inventory: {
          capabilities: [{ name: "coding.codex", version: "0.166.0", ready: true, detail: "ok" }],
          repos: [{ name: "site", defaultBranch: "main", remoteUrl: "git@github.com:a/site.git" }],
          maxMode: PermissionMode.AUTO,
          maxConcurrentTasks: 2,
        },
        heldTasks: [{ taskId: "tsk_01", running: true, lastSeq: 7n }],
      },
    },
  }),
  taskFinished: create(EnvelopeSchema, {
    body: {
      case: "taskEvent",
      value: {
        taskId: "tsk_01",
        seq: 8n,
        atMs: 1_767_225_660_000n,
        kind: {
          case: "finished",
          value: {
            outcome: TaskFinished_Outcome.SUCCEEDED,
            summary: "Made the footer year dynamic.",
            branch: "sling/ab12cd-footer-year",
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            diffStats: { filesChanged: 2, insertions: 14, deletions: 1 },
          },
        },
      },
    },
  }),
} as const;
