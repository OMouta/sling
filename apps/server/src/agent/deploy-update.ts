import type { ActionView } from "@sling/core";

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

function checkLine(c: NonNullable<ActionView["verify"]>["checks"][number]): string {
  const seen = c.status !== null ? String(c.status) : "no answer";
  return `${c.url} answered ${seen}${c.ok ? "" : ` (${c.error ?? "failed"})`}`;
}

/** One delivery step for a "[Sling update]", with what the merge, deploy, or check saw. */
export function stepLine(a: ActionView): string {
  const head = `Delivery step ${a.kind}: ${a.state}`;
  const message = a.message ? ` (${a.message})` : "";
  switch (a.kind) {
    case "merge": {
      const where = a.ranOn ? ` on ${a.ranOn}` : "";
      const commit = short(a.commitSha) ? `, commit ${short(a.commitSha)}` : "";
      return `${head}${where}${commit}${a.url ? ` ${a.url}` : ""}${message}`;
    }
    case "deploy": {
      const to = a.targetName ? ` to ${a.targetName}` : "";
      const where = a.ranOn ? ` from ${a.ranOn}` : "";
      const commit = short(a.commitSha) ? `, commit ${short(a.commitSha)}` : "";
      return `${head}${to}${where}${commit}${message}`;
    }
    case "verify": {
      const v = a.verify;
      if (!v || v.attempts === 0) return `${head}${message}`;
      const checks = v.checks.map(checkLine).join("; ");
      const version =
        v.versionSeen === null
          ? "There's no version URL, so which version answered is unknown."
          : v.versionSeen
            ? `The version URL shows ${short(a.commitSha)}.`
            : `The version URL doesn't show ${short(a.commitSha)}.`;
      return `${head} after ${v.attempts} ${v.attempts === 1 ? "attempt" : "attempts"}. Checks: ${checks}. ${version}`;
    }
    default:
      return `${head}${a.url ? ` ${a.url}` : ""}${message}`;
  }
}

/** What a finished deploy means, said plainly, with the way back when verify failed. */
export function deployOutcome(repoName: string, steps: ActionView[]): string[] {
  const verify = steps.find((a) => a.kind === "verify");
  if (!verify) return [];
  const merge = steps.find((a) => a.kind === "merge");
  if (verify.state === "succeeded") {
    return [`The fix is live: verify passed on ${verify.targetName ?? "the deploy target"}.`];
  }
  if (verify.state === "failed") {
    const commit = merge?.commitSha ? ` ${merge.commitSha}` : "";
    return [
      `Verification failed: the deploy went out, but ${verify.targetName ?? "the site"} doesn't pass its checks, so it isn't fixed.`,
      `Offer the user a revert task: a coding task in ${repoName} that reverts the merged commit${commit}, delivered with deliver "deploy". Start it only if they say yes.`,
    ];
  }
  return [];
}
