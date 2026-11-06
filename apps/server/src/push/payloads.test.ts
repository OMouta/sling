import { describe, expect, it } from "vitest";
import {
  chatApprovalPayload,
  deliveryOf,
  encodePayload,
  endpointProblem,
  MAX_PAYLOAD_BYTES,
  notificationSettings,
  replyPayload,
  taskApprovalPayload,
  taskSettledPayload,
  topicFor,
} from "./payloads.ts";

describe("push endpoints", () => {
  it("accepts the known push services over HTTPS", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGx2",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]) {
      expect(endpointProblem(url), url).toBeNull();
    }
  });

  it("refuses everything else", () => {
    expect(endpointProblem("http://fcm.googleapis.com/fcm/send/x")).toMatch(/HTTPS/);
    expect(endpointProblem("https://fcm.googleapis.com:8443/x")).toMatch(/port/);
    expect(endpointProblem("https://user:pw@fcm.googleapis.com/x")).toMatch(/credentials/);
    expect(endpointProblem("https://evil.example.com/push")).toMatch(/isn't a push service/);
    expect(endpointProblem("https://fcm.googleapis.com.evil.com/x")).toMatch(/isn't/);
    expect(endpointProblem("https://notify.windows.com/w")).toMatch(/isn't/);
    expect(endpointProblem("https://a.b.notify.windows.com/w")).toMatch(/isn't/);
    expect(endpointProblem("https://127.0.0.1/push")).toMatch(/isn't/);
    expect(endpointProblem("not a url")).toMatch(/isn't a URL/);
  });

  it("accepts extra origins exactly, for tests", () => {
    const extra = ["http://127.0.0.1:4555"];
    expect(endpointProblem("http://127.0.0.1:4555/push/1", extra)).toBeNull();
    expect(endpointProblem("http://127.0.0.1:4556/push/1", extra)).toMatch(/HTTPS/);
  });
});

describe("push service answers", () => {
  it("counts 201 as delivered, 404 and 410 as gone, the rest as failures", () => {
    expect(deliveryOf(201)).toBe("delivered");
    expect(deliveryOf(410)).toBe("gone");
    expect(deliveryOf(404)).toBe("gone");
    for (const s of [400, 401, 403, 413, 429, 500, 503]) expect(deliveryOf(s)).toBe("failed");
  });

  it("derives a short, URL-safe topic from the tag", () => {
    const t = topicFor("task:tsk_123");
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicFor("task:tsk_123")).toBe(t);
    expect(topicFor("task:tsk_124")).not.toBe(t);
  });
});

describe("categories", () => {
  it("are all on until set", () => {
    expect(notificationSettings(null)).toEqual({ approvals: true, tasks: true, replies: true });
    expect(notificationSettings({ replies: false })).toEqual({
      approvals: true,
      tasks: true,
      replies: false,
    });
  });

  it("ignore anything that isn't a boolean", () => {
    const stored = { tasks: "no", extra: true } as unknown as { tasks: boolean };
    expect(notificationSettings(stored)).toEqual({ approvals: true, tasks: true, replies: true });
  });
});

describe("payloads", () => {
  it("stay under 3 KB and only open paths in the app", () => {
    const big = encodePayload({
      title: "é".repeat(500),
      body: "😀".repeat(1000),
      url: "/",
      tag: "t",
    });
    expect(big.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const p = JSON.parse(
      encodePayload({ title: "a", body: "", url: "https://evil.com", tag: "t" }).toString(),
    );
    expect(p.url).toBe("/");
    expect(
      JSON.parse(encodePayload({ title: "a", body: "", url: "//evil.com", tag: "t" }).toString())
        .url,
    ).toBe("/");
    expect(
      JSON.parse(encodePayload({ title: "a", body: "", url: "/c/cnv_1", tag: "t" }).toString()).url,
    ).toBe("/c/cnv_1");
  });

  it("ask to approve a deployment by the target's name", () => {
    expect(
      taskApprovalPayload({
        taskId: "tsk_1",
        taskTitle: "Fix the 500",
        kinds: ["merge", "deploy"],
        targetName: "Website",
        repoName: "site",
      }),
    ).toEqual({
      title: "Approve deployment of Website?",
      body: "Fix the 500",
      url: "/approvals",
      tag: "task:tsk_1",
    });
    const pr = taskApprovalPayload({
      taskId: "tsk_1",
      taskTitle: "Fix",
      kinds: ["push", "open_pr"],
      targetName: null,
      repoName: "site",
    });
    expect(pr.title).toBe("Approve pull request?");
  });

  it("put chat approvals and replies on the chat's tag", () => {
    const a = chatApprovalPayload({
      conversationId: "cnv_1",
      conversationTitle: "Disk space",
      kind: "command",
      machine: "laptop",
      summary: "",
    });
    const r = replyPayload({
      conversationId: "cnv_1",
      conversationTitle: "Disk space",
      personalityName: null,
    });
    expect(a).toMatchObject({
      title: "Run a command on laptop?",
      url: "/c/cnv_1",
      tag: "conv:cnv_1",
    });
    expect(r).toEqual({
      title: "Disk space",
      body: "Sling replied.",
      url: "/c/cnv_1",
      tag: "conv:cnv_1",
    });
  });

  it("say how a task ended, and nothing when the user stopped it", () => {
    const task = { id: "tsk_1", title: "Fix the footer", repoName: "site", filesChanged: 2 };
    expect(
      taskSettledPayload({ ...task, state: "succeeded", actions: [], reason: "finished" }),
    ).toEqual({
      title: "Done: Fix the footer",
      body: "site, 2 files changed.",
      url: "/tasks/tsk_1",
      tag: "task:tsk_1",
    });
    expect(
      taskSettledPayload({ ...task, state: "failed", actions: [], reason: "finished" })?.title,
    ).toBe("Failed: Fix the footer");
    expect(
      taskSettledPayload({ ...task, state: "cancelled", actions: [], reason: "finished" }),
    ).toBeNull();
    const delivered = taskSettledPayload({
      ...task,
      state: "succeeded",
      actions: [
        { kind: "push", state: "succeeded" },
        { kind: "open_pr", state: "succeeded" },
      ],
      reason: "delivered",
    });
    expect(delivered).toMatchObject({
      title: "Delivered: Fix the footer",
      body: "Opened the pull request.",
    });
    const verifyFailed = taskSettledPayload({
      ...task,
      state: "succeeded",
      actions: [
        { kind: "merge", state: "succeeded" },
        { kind: "verify", state: "failed" },
      ],
      reason: "delivered",
    });
    expect(verifyFailed).toMatchObject({
      title: "Couldn't deliver: Fix the footer",
      body: "Deployed, but the checks still fail.",
    });
    expect(
      taskSettledPayload({
        ...task,
        state: "succeeded",
        actions: [{ kind: "push", state: "rejected" }],
        reason: "delivered",
      }),
    ).toBeNull();
  });
});
