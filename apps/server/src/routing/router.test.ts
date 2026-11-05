import { describe, expect, it } from "vitest";
import {
  keyFromInput,
  type MachineCandidate,
  type RouteRequest,
  type RouterInput,
  route,
} from "./router.ts";

const SITE = "github.com/a/site";

function machine(over: Partial<MachineCandidate> & { id: string }): MachineCandidate {
  return {
    name: over.id,
    online: true,
    labels: ["os:macos", "arch:aarch64"],
    capabilities: [
      { name: "coding.codex", ready: true, detail: "" },
      { name: "coding.claude-code", ready: false, detail: "not logged in" },
    ],
    maxMode: "full-access",
    maxConcurrentTasks: 2,
    load: 0,
    pairedAt: new Date("2026-01-01T00:00:00Z"),
    repos: [{ id: `${over.id}-site`, name: "site", remoteKey: SITE, lastTaskAt: null }],
    ...over,
  };
}

function input(over: Partial<RouterInput> = {}, req: Partial<RouteRequest> = {}): RouterInput {
  return {
    request: {
      repo: "site",
      harness: "codex",
      labels: [],
      environment: "auto",
      machineId: null,
      providerInstallationId: null,
      ...req,
    },
    mode: "auto",
    machines: [machine({ id: "laptop" })],
    sandboxRepos: [],
    providers: [],
    sandboxBudget: { usedMinutes: 0, budgetMinutes: 600 },
    now: new Date("2026-11-05T12:00:00Z"),
    ...over,
  };
}

const docker = { id: "ins_docker", name: "docker-host", connectorName: "Docker" };
const railway = { id: "ins_railway", name: "railway-prod", connectorName: "Railway" };
const allowSite = {
  remoteKey: SITE,
  cloneUrl: "https://github.com/a/site.git",
  defaultBranch: "main",
  network: false,
};

function picked(i: RouterInput): string {
  const r = route(i);
  if (r.decision.kind !== "machine") throw new Error(`expected a machine, got ${r.decision.kind}`);
  return r.decision.runnerId;
}

function considered(i: RouterInput) {
  return Object.fromEntries(route(i).routing.considered.map((c) => [c.runnerName, c.reason]));
}

describe("eligibility", () => {
  it("picks the only machine that fits and says why", () => {
    const r = route(input());
    expect(r.decision).toMatchObject({
      kind: "machine",
      runnerId: "laptop",
      repoId: "laptop-site",
      repoName: "site",
      queued: false,
    });
    expect(r.routing).toEqual({
      target: { kind: "machine", runnerId: "laptop", runnerName: "laptop" },
      reason: "Runs on laptop: it's the only machine that can take it.",
      considered: [
        {
          runnerId: "laptop",
          runnerName: "laptop",
          eligible: true,
          reason: "Picked: it's the only machine that can take it",
        },
      ],
      decidedAt: "2026-11-05T12:00:00.000Z",
    });
  });

  it("skips offline machines", () => {
    const i = input({
      machines: [machine({ id: "laptop", online: false }), machine({ id: "desktop" })],
    });
    expect(picked(i)).toBe("desktop");
    expect(considered(i).laptop).toBe("Offline");
  });

  it("skips machines without the repo", () => {
    const i = input({
      machines: [machine({ id: "laptop", repos: [] }), machine({ id: "desktop" })],
    });
    expect(picked(i)).toBe("desktop");
    expect(considered(i).laptop).toBe("Doesn't have site");
  });

  it("needs the requested agent installed and ready", () => {
    const i = input(
      {
        machines: [
          machine({ id: "laptop" }),
          machine({
            id: "desktop",
            capabilities: [{ name: "coding.codex", ready: true, detail: "" }],
          }),
          machine({
            id: "studio",
            capabilities: [{ name: "coding.claude-code", ready: true, detail: "" }],
          }),
        ],
      },
      { harness: "claude-code" },
    );
    expect(picked(i)).toBe("studio");
    expect(considered(i)).toMatchObject({
      laptop: "Claude Code isn't ready (not logged in)",
      desktop: "Claude Code isn't installed",
    });
  });

  it("needs every required label, compared case-insensitively", () => {
    const i = input(
      {
        machines: [
          machine({ id: "laptop", labels: ["ios"] }),
          machine({ id: "mac", labels: ["iOS", "GPU", "os:macos"] }),
        ],
      },
      { labels: [" ios", "gpu"] },
    );
    expect(picked(i)).toBe("mac");
    expect(considered(i).laptop).toBe("Doesn't have the label gpu");
    const none = input({ machines: [machine({ id: "laptop" })] }, { labels: ["ios", "gpu"] });
    expect(considered(none).laptop).toBe("Doesn't have the labels ios, gpu");
  });

  it("needs the conversation's mode within the machine's cap", () => {
    const i = input({
      mode: "full-access",
      machines: [machine({ id: "laptop", maxMode: "supervised" })],
    });
    const r = route(i);
    expect(r.decision.kind).toBe("refused");
    expect(considered(i).laptop).toBe(
      "Allows at most supervised mode, and this conversation is in full-access",
    );
  });

  it("lists every problem a machine has", () => {
    const i = input(
      { machines: [machine({ id: "laptop", online: false, repos: [] })] },
      { labels: ["ios"] },
    );
    expect(considered(i).laptop).toBe("Offline; doesn't have site; doesn't have the label ios");
  });

  it("pins to the named machine when the environment is machine", () => {
    const i = input(
      { machines: [machine({ id: "laptop" }), machine({ id: "desktop", load: 2 })] },
      { environment: "machine", machineId: "desktop" },
    );
    expect(picked(i)).toBe("desktop");
    expect(considered(i).laptop).toBe("Not the machine you asked for");
    expect(route(i).decision).toMatchObject({ queued: true });
  });

  it("refuses an unknown named machine when pinned", () => {
    const r = route(input({}, { environment: "machine", machineId: "rnr_gone" }));
    expect(r.decision).toMatchObject({ kind: "refused" });
    if (r.decision.kind !== "refused") return;
    expect(r.decision.reasons[0]).toBe("There's no machine with the ID rnr_gone");
  });
});

describe("repo identity", () => {
  it("matches the same remote under different names", () => {
    const i = input({
      machines: [
        machine({ id: "laptop", online: false }),
        machine({
          id: "desktop",
          repos: [{ id: "d-web", name: "website", remoteKey: SITE, lastTaskAt: null }],
        }),
      ],
    });
    const r = route(i);
    expect(r.decision).toMatchObject({ kind: "machine", runnerId: "desktop", repoName: "website" });
  });

  it("accepts a remote key or a remote URL", () => {
    for (const repo of [SITE, "git@github.com:a/site.git", "https://github.com/A/site"]) {
      expect(route(input({}, { repo })).decision).toMatchObject({
        kind: "machine",
        repoName: "site",
      });
    }
  });

  it("matches a repo without a remote by name, on that machine only", () => {
    const local = { id: "l-notes", name: "notes", remoteKey: null, lastTaskAt: null };
    const i = input(
      {
        machines: [
          machine({ id: "laptop", repos: [local] }),
          machine({ id: "desktop", repos: [{ ...local, id: "d-notes", remoteKey: "x.com/b/n" }] }),
        ],
      },
      { repo: "notes" },
    );
    // Both are called notes; only one has a remote, so both match by name.
    expect(route(i).routing.considered.every((c) => c.eligible)).toBe(true);
    const byKey = input({ machines: i.machines }, { repo: "x.com/b/n" });
    expect(considered(byKey).laptop).toBe("Doesn't have x.com/b/n");
  });

  it("refuses a name that means two different remotes", () => {
    const r = route(
      input({
        machines: [
          machine({ id: "laptop" }),
          machine({
            id: "desktop",
            repos: [{ id: "x", name: "site", remoteKey: "github.com/b/site", lastTaskAt: null }],
          }),
        ],
      }),
    );
    expect(r.decision).toEqual({
      kind: "refused",
      message:
        "More than one repo is called site (github.com/a/site, github.com/b/site). Name it by its remote instead.",
      reasons: [
        "More than one repo is called site (github.com/a/site, github.com/b/site). Name it by its remote instead.",
      ],
    });
  });

  it("reads remote keys from input", () => {
    expect(keyFromInput("github.com/a/site")).toBe(SITE);
    expect(keyFromInput("GitHub.com/a/site.git/")).toBe(SITE);
    expect(keyFromInput("https://github.com/a/site.git")).toBe(SITE);
    expect(keyFromInput("site")).toBeNull();
    expect(keyFromInput("a/site")).toBeNull();
  });
});

describe("ranking", () => {
  const two = (a: Partial<MachineCandidate>, b: Partial<MachineCandidate>) => [
    machine({ id: "laptop", pairedAt: new Date("2026-01-01T00:00:00Z"), ...a }),
    machine({ id: "desktop", pairedAt: new Date("2026-02-01T00:00:00Z"), ...b }),
  ];

  it("puts the named machine first", () => {
    const i = input({ machines: two({ load: 1 }, {}) }, { machineId: "laptop" });
    expect(picked(i)).toBe("laptop");
    expect(route(i).routing.reason).toBe("Runs on laptop: you asked for it.");
  });

  it("then prefers the most free slots", () => {
    const i = input({ machines: two({ load: 1 }, {}) });
    expect(picked(i)).toBe("desktop");
    expect(route(i).routing.reason).toBe(
      "Runs on desktop: it has the most free slots (2 of 2 slots free).",
    );
    expect(considered(i).laptop).toBe("Eligible, 1 of 2 slots free");
  });

  it("then the machine that ran the repo most recently", () => {
    const repo = (id: string, at: string | null) => [
      { id, name: "site", remoteKey: SITE, lastTaskAt: at ? new Date(at) : null },
    ];
    const i = input({
      machines: two(
        { repos: repo("l", "2026-11-01T00:00:00Z") },
        { repos: repo("d", "2026-11-04T00:00:00Z") },
      ),
    });
    expect(picked(i)).toBe("desktop");
    expect(route(i).routing.reason).toBe(
      "Runs on desktop: it ran site most recently, so its worktrees and caches are warm.",
    );
  });

  it("then the oldest pairing", () => {
    const i = input({ machines: two({}, {}) });
    expect(picked(i)).toBe("laptop");
    expect(route(i).routing.reason).toBe("Runs on laptop: it was paired first.");
  });

  it("queues on the best machine when every eligible one is busy", () => {
    const i = input({ machines: two({ load: 3 }, { load: 2 }) });
    const r = route(i);
    expect(r.decision).toMatchObject({ kind: "machine", runnerId: "desktop", queued: true });
    expect(r.routing.reason).toBe(
      "Queued on desktop: every machine that can take it is busy, and it has the most free slots (0 of 2 slots free).",
    );
    expect(considered(i).desktop).toMatch(/^Picked, though busy/);
  });
});

describe("sandboxes", () => {
  const offline = [machine({ id: "laptop", online: false })];

  it("offers a sandbox when no machine qualifies and the repo is allowed", () => {
    const r = route(input({ machines: offline, sandboxRepos: [allowSite], providers: [docker] }));
    expect(r.decision).toEqual({
      kind: "sandbox",
      fallback: true,
      provider: docker,
      repo: allowSite,
      repoName: "site",
      reasons: ["laptop: Offline"],
    });
    expect(r.routing.target).toEqual({
      kind: "sandbox",
      providerInstallationId: "ins_docker",
      providerName: "docker-host",
    });
    expect(r.routing.reason).toBe(
      "No machine can take it, so it can run in a Docker sandbox on docker-host once you approve.",
    );
  });

  it("uses the named provider, else the first", () => {
    const base = { machines: offline, sandboxRepos: [allowSite], providers: [docker, railway] };
    expect(route(input(base)).decision).toMatchObject({ provider: docker });
    expect(route(input(base, { providerInstallationId: "ins_railway" })).decision).toMatchObject({
      provider: railway,
    });
    expect(route(input(base, { providerInstallationId: "ins_nope" })).decision).toMatchObject({
      kind: "refused",
    });
  });

  it("refuses a repo that isn't allowed in sandboxes", () => {
    const r = route(input({ machines: offline, providers: [docker] }));
    expect(r.decision).toEqual({
      kind: "refused",
      message:
        "No machine can take this task.\n- laptop: Offline\n- It can't go to a sandbox either: github.com/a/site isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page",
      reasons: [
        "laptop: Offline",
        "It can't go to a sandbox either: github.com/a/site isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page",
      ],
    });
    expect(r.routing.target).toBeNull();
  });

  it("refuses without a provider", () => {
    const r = route(input({ machines: offline, sandboxRepos: [allowSite] }));
    expect(r.decision.kind === "refused" && r.decision.reasons.at(-1)).toBe(
      "It can't go to a sandbox either: no sandbox provider is set up. Add one, such as Docker, under Connectors",
    );
  });

  it("refuses when the monthly budget is used up", () => {
    const r = route(
      input({
        machines: offline,
        sandboxRepos: [allowSite],
        providers: [docker],
        sandboxBudget: { usedMinutes: 600, budgetMinutes: 600 },
      }),
    );
    expect(r.decision.kind === "refused" && r.decision.reasons.at(-1)).toBe(
      "It can't go to a sandbox either: this month's 600 sandbox minutes are used up. Raise the budget in Settings to run more",
    );
  });

  it("doesn't send labelled work to a sandbox, except os:linux", () => {
    const base = { machines: offline, sandboxRepos: [allowSite], providers: [docker] };
    const r = route(input(base, { labels: ["ios"] }));
    expect(r.decision.kind === "refused" && r.decision.reasons.at(-1)).toBe(
      "It can't go to a sandbox either: sandboxes don't have the label ios",
    );
    expect(route(input(base, { labels: ["os:linux"] })).decision.kind).toBe("sandbox");
  });

  it("never offers a sandbox when the environment is machine", () => {
    const r = route(
      input(
        { machines: offline, sandboxRepos: [allowSite], providers: [docker] },
        { environment: "machine" },
      ),
    );
    expect(r.decision).toEqual({
      kind: "refused",
      message: "No machine can take this task.\n- laptop: Offline",
      reasons: ["laptop: Offline"],
    });
  });

  it("runs in a sandbox when asked, even with a machine online", () => {
    const r = route(
      input({ sandboxRepos: [allowSite], providers: [docker] }, { environment: "sandbox" }),
    );
    expect(r.decision).toMatchObject({ kind: "sandbox", fallback: false, repoName: "site" });
    expect(r.routing).toMatchObject({
      reason: "Runs in a Docker sandbox on docker-host, as you asked.",
      considered: [],
    });
  });

  it("refuses a requested sandbox with the reason", () => {
    const r = route(input({ providers: [docker] }, { environment: "sandbox" }));
    expect(r.decision).toMatchObject({
      kind: "refused",
      message:
        "Can't run it in a sandbox: github.com/a/site isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page.",
    });
  });

  it("finds an allowed repo no machine has by its name", () => {
    const r = route(
      input(
        { machines: [], sandboxRepos: [allowSite], providers: [docker] },
        { environment: "sandbox" },
      ),
    );
    expect(r.decision).toMatchObject({ kind: "sandbox", repoName: "site" });
    const auto = route(input({ machines: [], sandboxRepos: [allowSite], providers: [docker] }));
    expect(auto.decision).toMatchObject({
      kind: "sandbox",
      fallback: true,
      reasons: ["No machines are paired"],
    });
  });

  it("explains a repo nobody knows, and one without a remote", () => {
    const unknown = route(input({ providers: [docker] }, { repo: "ghost" }));
    expect(unknown.decision.kind === "refused" && unknown.decision.message).toBe(
      "No machine can take this task.\n- laptop: Doesn't have ghost\n- It can't go to a sandbox either: Sling doesn't know a repo called ghost",
    );
    const local = route(
      input({
        machines: [
          machine({
            id: "laptop",
            online: false,
            repos: [{ id: "n", name: "site", remoteKey: null, lastTaskAt: null }],
          }),
        ],
        providers: [docker],
      }),
    );
    expect(local.decision.kind === "refused" && local.decision.reasons.at(-1)).toBe(
      "It can't go to a sandbox either: site has no remote, so a sandbox has nothing to clone",
    );
  });
});

describe("speed", () => {
  it("decides for 200 machines with 50 repos each well under 20 ms", () => {
    const machines = Array.from({ length: 200 }, (_, i) =>
      machine({
        id: `m${i}`,
        load: i % 3,
        repos: Array.from({ length: 50 }, (_, j) => ({
          id: `m${i}-r${j}`,
          name: j === 49 ? "site" : `repo${j}`,
          remoteKey: j === 49 ? SITE : `github.com/a/repo${j}`,
          lastTaskAt: new Date(1_700_000_000_000 + i * 1000),
        })),
      }),
    );
    const i = input({ machines }, { labels: ["os:macos"] });
    route(i);
    const started = performance.now();
    for (let n = 0; n < 10; n++) route(i);
    expect((performance.now() - started) / 10).toBeLessThan(20);
  });
});
