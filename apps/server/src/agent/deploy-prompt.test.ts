import type { ActionView } from "@sling/core";
import { describe, expect, it } from "vitest";
import { personalityTemplate } from "../personalities/templates.ts";
import { deployOutcome, stepLine } from "./deploy-update.ts";
import { assistantInstructions } from "./prompt.ts";
import { agentTools, allowedTools } from "./tools.ts";

const now = new Date("2026-11-06T12:00:00Z");
const incident = personalityTemplate("incident");
const sling = personalityTemplate("sling");
if (!incident || !sling) throw new Error("personality templates missing");

describe("the Deploys part of the prompt", () => {
  it("is there only for a personality with the deploys group", () => {
    const p = assistantInstructions(incident, "auto", now);
    expect(p).toContain('Deploys (run_check, deploy_task, and deliver "deploy"):');
    expect(p).toContain("You name a target, never a URL.");
    expect(p).toContain('"Approve deployment?"');
    expect(p).toContain("offer a revert task");
    const plain = assistantInstructions(
      { instructions: "You are Ops.", tools: ["commands", "coding"] },
      "auto",
      now,
    );
    expect(plain).not.toContain("run_check");
    expect(plain).not.toContain("Approve deployment?");
  });

  it("says what each mode does with a deploy", () => {
    expect(assistantInstructions(incident, "full-access", now)).toContain(
      "In Full access a deploy doesn't ask",
    );
    expect(assistantInstructions(incident, "read-only", now)).toContain(
      "This conversation is Read-only, so it can't deploy.",
    );
  });

  it("offers the deploy tools and delivery only with the group", () => {
    expect([...allowedTools(["deploys"])]).toEqual(["list_machines", "run_check", "deploy_task"]);
    const scope = { workspaceId: "w", ownerId: "u", conversationId: "c" };
    const ctx = {} as never;
    const coding = agentTools(ctx, scope, allowedTools(["coding"]));
    const both = agentTools(ctx, scope, allowedTools(["coding", "deploys"]));
    const deliveries = (t: typeof coding) => {
      const schema = t.delegate_coding_task?.inputSchema as unknown as
        | { shape: { deliver: { unwrap(): { options: string[] } } } }
        | undefined;
      return schema?.shape.deliver.unwrap().options ?? [];
    };
    expect(deliveries(coding)).toEqual(["local", "push", "pr"]);
    expect(deliveries(both)).toEqual(["local", "push", "pr", "deploy"]);
    expect(Object.keys(coding)).not.toContain("run_check");
    expect(Object.keys(both)).toContain("deploy_task");
  });
});

function step(over: Partial<ActionView>): ActionView {
  return {
    id: "act",
    taskId: "tsk",
    kind: "merge",
    state: "succeeded",
    requiresApproval: true,
    url: null,
    message: null,
    approvalId: null,
    targetId: "dpt",
    targetName: "Website",
    ranOn: null,
    commitSha: null,
    output: null,
    verify: null,
    ...over,
  };
}

describe("what a task update says about a deploy", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const checks = [
    {
      url: "https://site/health",
      ok: false,
      status: 500,
      ms: 4,
      error: "Expected 200 to 399, got 500",
    },
  ];

  it("names where the merge ran, the commit, and each check", () => {
    expect(stepLine(step({ ranOn: "laptop", commitSha: sha, message: "Merged." }))).toBe(
      "Delivery step merge: succeeded on laptop, commit 0123456 (Merged.)",
    );
    expect(stepLine(step({ kind: "deploy", ranOn: "Sling", commitSha: sha }))).toBe(
      "Delivery step deploy: succeeded to Website from Sling, commit 0123456",
    );
    expect(
      stepLine(
        step({
          kind: "verify",
          state: "failed",
          commitSha: sha,
          verify: {
            attempts: 3,
            checks,
            versionSeen: false,
            startedAt: "2026-11-06T14:00:00Z",
            finishedAt: "2026-11-06T14:00:30Z",
          },
        }),
      ),
    ).toBe(
      "Delivery step verify: failed after 3 attempts. Checks: https://site/health answered 500 (Expected 200 to 399, got 500). The version URL doesn't show 0123456.",
    );
  });

  it("says a passing verify means live, and offers a revert when it fails", () => {
    expect(deployOutcome("site", [step({ kind: "verify", state: "succeeded" })])).toEqual([
      "The fix is live: verify passed on Website.",
    ]);
    const failed = deployOutcome("site", [
      step({ kind: "merge", commitSha: sha }),
      step({ kind: "verify", state: "failed" }),
    ]);
    expect(failed[0]).toMatch(/^Verification failed: the deploy went out/);
    expect(failed[1]).toBe(
      `Offer the user a revert task: a coding task in site that reverts the merged commit ${sha}, delivered with deliver "deploy". Start it only if they say yes.`,
    );
    expect(deployOutcome("site", [step({ kind: "open_pr" })])).toEqual([]);
  });
});
