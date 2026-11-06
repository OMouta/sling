import { describe, expect, it } from "vitest";
import {
  apiTarget,
  deliveredPrTask,
  deployWaitingTask,
  devbox,
  docsTarget,
  lockedMac,
  sandboxRepos,
  sandboxRunner,
  studioMac,
  websiteTarget,
} from "../test/fixtures.ts";
import {
  canDeployLater,
  deployMachines,
  deployPlan,
  draftBody,
  draftFor,
  knownRemotes,
  prLabel,
  setCommandLine,
  shortUrl,
  targetForRemote,
  targetForTask,
  validateDraft,
} from "./deploys.ts";

describe("deploy helpers", () => {
  it("knows each remote once, from machines and the sandbox list, never a sandbox's Runner", () => {
    const remotes = knownRemotes([devbox, studioMac, sandboxRunner], sandboxRepos);
    expect(remotes.map((r) => [r.remoteKey, r.onMachines.length, r.inSandboxes])).toEqual([
      ["github.com/a/api", 0, true],
      ["github.com/a/site", 2, false],
    ]);
  });

  it("offers machines with a deploy command, saying which would refuse", () => {
    const [site] = knownRemotes([devbox, studioMac, lockedMac]).filter(
      (r) => r.remoteKey === "github.com/a/site",
    );
    expect(deployMachines(site).map((m) => [m.runner.name, m.command, m.blocked])).toEqual([
      ["locked-mac", "fly deploy", "deploys are off"],
      ["Studio Mac", "fly deploy", null],
    ]);
    expect(setCommandLine("site")).toBe('sling-runner repo set site deploy-command "…"');
    expect(setCommandLine("my site")).toBe('sling-runner repo set "my site" deploy-command "…"');
  });

  it("round-trips a target through the form, leaving defaults empty", () => {
    const d = draftFor(websiteTarget);
    expect(d.settleSeconds).toBe("");
    expect(d.timeoutSeconds).toBe("");
    expect(d.checks.map((c) => [c.url, c.status, c.contains])).toEqual([
      ["https://example.com/", "", ""],
      ["https://example.com/health", "200", "ok"],
    ]);
    expect(draftBody(d, websiteTarget)).toEqual({
      name: "Website",
      remoteKey: "github.com/a/site",
      method: "command",
      mergeMethod: "squash",
      runnerId: "rnr_3",
      checks: websiteTarget.checks,
      versionUrl: "https://example.com/version",
      settleSeconds: 0,
      timeoutSeconds: 600,
    });
  });

  it("needs the hook again only when it's new or replaced", () => {
    const ctx = { targets: [apiTarget], editing: apiTarget };
    const kept = draftFor(apiTarget);
    expect(validateDraft(kept, ctx)).toEqual({});
    expect("hook" in draftBody(kept, apiTarget)).toBe(false);
    expect(validateDraft({ ...kept, replaceHook: true }, ctx).hookUrl).toBe(
      "Paste the deploy hook's URL.",
    );
    const fresh = { ...draftFor(null, "github.com/a/site"), name: "Site", method: "hook" as const };
    fresh.checks[0] = { key: "k", url: "https://example.com", status: "", contains: "" };
    expect(validateDraft(fresh, { targets: [], editing: null })).toEqual({
      hookUrl: "Paste the deploy hook's URL.",
    });
  });

  it("checks timing and statuses as whole numbers in range", () => {
    const d = {
      ...draftFor(null, "github.com/a/site"),
      name: "Site",
      settleSeconds: "1.5",
      timeoutSeconds: "5000",
    };
    d.checks[0] = { key: "k", url: "https://example.com", status: "700", contains: "" };
    expect(validateDraft(d, { targets: [], editing: null })).toEqual({
      settleSeconds: "Whole seconds, up to 3600.",
      timeoutSeconds: "Whole seconds, 10 to 3600.",
      "check.0.status": "A status is 100 to 599.",
    });
  });

  it("finds a task's target by its steps, its repo's remote, or a lone name match", () => {
    expect(targetForTask(deployWaitingTask, [websiteTarget, docsTarget], [])?.id).toBe("dpt_site");
    expect(targetForTask(deliveredPrTask, [docsTarget, websiteTarget], [studioMac])?.id).toBe(
      "dpt_site",
    );
    // Without a machine to go by, a target whose remote ends in the repo's name.
    expect(targetForTask(deliveredPrTask, [docsTarget, websiteTarget], [])?.id).toBe("dpt_site");
    expect(targetForTask(deliveredPrTask, [docsTarget], [studioMac])).toBeUndefined();
    expect(targetForRemote("https://github.com/A/site.git", [websiteTarget])?.id).toBe("dpt_site");
  });

  it("offers Deploy only on a delivered PR with no deploy steps yet", () => {
    expect(canDeployLater(deliveredPrTask)).toBe(true);
    expect(canDeployLater(deployWaitingTask)).toBe(false);
    expect(canDeployLater({ ...deliveredPrTask, state: "running" })).toBe(false);
    expect(canDeployLater({ ...deliveredPrTask, actions: [] })).toBe(false);
  });

  it("says what a deployment will do", () => {
    expect(prLabel("https://github.com/a/site/pull/12")).toBe("PR #12");
    expect(prLabel("https://gitlab.com/a/site/-/merge_requests/7")).toBe("PR #7");
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(
      deployPlan({
        prUrl: null,
        branch: "sling/fix",
        defaultBranch: null,
        target: { ...websiteTarget, checks: [...websiteTarget.checks, ...docsTarget.checks] },
      }),
    ).toEqual({
      what: "sling/fix",
      into: "the default branch",
      mergeMethod: "squash",
      method: "command",
      command: "fly deploy",
      machine: "Studio Mac",
      hookHost: null,
      checks: ["example.com", "docs.example.com"],
    });
  });
});
