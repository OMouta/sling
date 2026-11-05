/** Coding agents a task can run. Each needs a `coding.<name>` capability on the machine. */
export const HARNESSES = ["codex", "claude-code"] as const;
export type Harness = (typeof HARNESSES)[number];

export const DEFAULT_HARNESS: Harness = "codex";

export const HARNESS_LABELS: Record<Harness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

export function harnessCapability(harness: Harness): string {
  return `coding.${harness}`;
}

/** A Runner that can run assistant turns on its coding agents' CLIs reports this. */
export const CHAT_CAPABILITY = "chat";

/** Whether a machine's reported capabilities let the assistant chat on this agent there. */
export function canChatOn(capabilities: { name: string; ready: boolean }[], harness: Harness) {
  return (
    capabilities.some((c) => c.name === CHAT_CAPABILITY && c.ready) &&
    capabilities.some((c) => c.name === harnessCapability(harness) && c.ready)
  );
}

/**
 * Environment variables a sandbox image is started with. The Runner's
 * `sling-runner sandbox` command reads these.
 */
export const SANDBOX_ENV = {
  url: "SLING_URL",
  pairCode: "SLING_PAIR_CODE",
  sandboxId: "SLING_SANDBOX_ID",
  /** JSON: [{ name, cloneUrl, defaultBranch, network }] */
  repos: "SLING_REPOS",
  /** Comma-separated harness names to set up. */
  harnesses: "SLING_HARNESSES",
  maxMode: "SLING_MAX_MODE",
  idleExitSeconds: "SLING_IDLE_EXIT_SECONDS",
  openaiApiKey: "OPENAI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  /** Used by the Runner for git and gh. Never passed to the agent. */
  gitToken: "SLING_GIT_TOKEN",
} as const;

/**
 * `host/owner/name` from a git remote, lowercased, without `.git`, so the same
 * repo matches across machines. Null for remotes it can't read.
 */
export function remoteKey(remote: string): string | null {
  let r = remote.trim();
  if (!r) return null;
  r = r.replace(/\.git$/i, "").replace(/\/+$/, "");
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(r);
  if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(r);
      if (!["http:", "https:", "ssh:", "git:"].includes(u.protocol)) return null;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, "").replace(/\.git$/i, "");
  if (!host || !path.includes("/")) return null;
  return `${host}/${path}`.toLowerCase();
}

/** HTTPS clone URL for a remote key, for example `https://github.com/a/site.git`. */
export function cloneUrlFor(key: string): string {
  return `https://${key}.git`;
}
