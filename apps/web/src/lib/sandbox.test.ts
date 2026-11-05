import type { ApprovalView, ConnectorView } from "@sling/core";
import { describe, expect, it } from "vitest";
import {
  busySandbox,
  connectors,
  destroyedSandbox,
  dockerInstallation,
  fallbackApproval,
  installations,
  providerConnectors,
} from "../test/fixtures.ts";
import {
  costPerHourBody,
  fallbackPayload,
  isLiveSandbox,
  isProviderConnector,
  minutes,
  pendingFallbackFor,
  providerInstallations,
  sandboxRunMs,
  secretsBody,
} from "./sandbox.ts";

describe("isProviderConnector", () => {
  it("knows Docker and Railway by ID", () => {
    expect(providerConnectors.map(isProviderConnector)).toEqual([true, true]);
    expect(connectors.map(isProviderConnector)).toEqual([false, false]);
  });

  it("prefers the connector's own flag when the server sends one", () => {
    const flagged = { ...connectors[0], isExecutionProvider: true } as ConnectorView;
    const unflagged = { ...providerConnectors[0], isExecutionProvider: false } as ConnectorView;
    expect(isProviderConnector(flagged)).toBe(true);
    expect(isProviderConnector(unflagged)).toBe(false);
  });
});

describe("providerInstallations", () => {
  it("keeps installations of provider connectors", () => {
    const all = [...installations, dockerInstallation];
    expect(providerInstallations(all, [...connectors, ...providerConnectors])).toEqual([
      dockerInstallation,
    ]);
  });

  it("judges installations of unlisted connectors by ID", () => {
    expect(providerInstallations([dockerInstallation], [])).toEqual([dockerInstallation]);
  });
});

describe("sandbox lifetime", () => {
  it("treats destroyed and failed sandboxes as gone", () => {
    expect(isLiveSandbox("busy")).toBe(true);
    expect(isLiveSandbox("requested")).toBe(true);
    expect(isLiveSandbox("releasing")).toBe(true);
    expect(isLiveSandbox("failed")).toBe(false);
    expect(isLiveSandbox("destroyed")).toBe(false);
  });

  it("runs from the request to destruction, or to now", () => {
    expect(sandboxRunMs(destroyedSandbox)).toBe(12 * 60_000 + 10_000);
    const now = new Date("2026-11-05T10:05:30.000Z").getTime();
    expect(sandboxRunMs(busySandbox, now)).toBe(5 * 60_000 + 30_000);
  });

  it("formats minutes", () => {
    expect(minutes(0)).toBe("0 min");
    expect(minutes(0.25)).toBe("0.3 min");
    expect(minutes(12.4)).toBe("12 min");
  });
});

describe("fallback approvals", () => {
  it("reads the payload", () => {
    expect(fallbackPayload(fallbackApproval)).toEqual({
      taskId: "tsk_wait",
      taskTitle: "Update the README badges",
      remoteKey: "github.com/a/site",
      cloneUrl: "https://github.com/a/site.git",
      providerInstallationId: "ins_docker",
      providerName: "Docker host",
      harness: "codex",
      reasons: ["devbox: Offline.", "buildbox: Doesn't have site."],
    });
  });

  it("rejects other kinds and payloads missing what the card shows", () => {
    expect(fallbackPayload({ ...fallbackApproval, kind: "workflow" })).toBeNull();
    expect(fallbackPayload({ ...fallbackApproval, payload: null })).toBeNull();
    expect(
      fallbackPayload({
        ...fallbackApproval,
        payload: { ...fallbackApproval.payload, harness: "opencode" },
      }),
    ).toBeNull();
  });

  it("takes the task from the approval when the payload leaves it out", () => {
    const { taskId: _, ...rest } = fallbackApproval.payload as Record<string, unknown>;
    expect(fallbackPayload({ ...fallbackApproval, payload: rest })?.taskId).toBe("tsk_wait");
  });

  it("finds the pending fallback for a task", () => {
    const decided: ApprovalView = { ...fallbackApproval, id: "apv_old", state: "rejected" };
    const byPayload: ApprovalView = { ...fallbackApproval, taskId: null };
    expect(pendingFallbackFor([decided, fallbackApproval], "tsk_wait")?.id).toBe("apv_fb");
    expect(pendingFallbackFor([byPayload], "tsk_wait")?.id).toBe("apv_fb");
    expect(pendingFallbackFor([decided], "tsk_wait")).toBeUndefined();
    expect(pendingFallbackFor(undefined, "tsk_wait")).toBeUndefined();
  });
});

describe("request bodies", () => {
  it("sends only the secrets you typed", () => {
    expect(secretsBody({})).toEqual({});
    expect(secretsBody({ openaiApiKey: "  sk-1\n", anthropicApiKey: "", gitToken: "   " })).toEqual(
      { openaiApiKey: "sk-1" },
    );
  });

  it("drops blank and invalid costs", () => {
    expect(costPerHourBody({ a: "0.12", b: "", c: "-1", d: "abc", e: "0" })).toEqual({
      a: 0.12,
      e: 0,
    });
  });
});
