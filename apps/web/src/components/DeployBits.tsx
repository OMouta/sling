import type { DeployCheckResult, DeployTargetView } from "@sling/core";
import type { ReactNode } from "react";
import { checkStatusText, type DeployPlan, MERGE_WORDS, shortUrl } from "../lib/deploys.ts";
import { duration } from "../lib/format.ts";
import { cx, Dot, Mono } from "./ui.tsx";

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** How a target deploys, in one line. */
export function MethodLine({
  target: t,
}: {
  target: Pick<DeployTargetView, "method" | "command" | "runnerName" | "hook">;
}) {
  switch (t.method) {
    case "merge":
      return <>Host deploys on merge</>;
    case "command":
      return t.command ? (
        <>
          Runs <Mono>{t.command}</Mono> on {t.runnerName ?? "a machine that's gone"}
        </>
      ) : (
        <span className="text-warn">
          Runs a command on {t.runnerName ?? "a machine that's gone"}, which has none set
        </span>
      );
    case "hook":
      return <>Calls a hook on {t.hook?.host ?? "a stored URL"}</>;
  }
}

/** "Merges PR #12 into main with squash, then runs `fly deploy` on Studio Mac, then checks example.com." */
export function DeployPlanText({ plan: p }: { plan: DeployPlan }) {
  const merge = `Merges ${p.what} into ${p.into}${p.mergeMethod ? ` ${MERGE_WORDS[p.mergeMethod]}` : ""}`;
  const checks = p.checks.length ? list.format(p.checks) : "the site";
  let deploy: ReactNode;
  switch (p.method) {
    case "merge":
      deploy = ", lets the host deploy it";
      break;
    case "command":
      deploy = p.command ? (
        <>
          , then runs <Mono>{p.command}</Mono>
          {p.machine ? ` on ${p.machine}` : ""}
        </>
      ) : (
        `, then runs the deploy command${p.machine ? ` on ${p.machine}` : ""}`
      );
      break;
    case "hook":
      deploy = `, then calls the deploy hook${p.hookHost ? ` on ${p.hookHost}` : ""}`;
      break;
    default:
      deploy = ", then deploys it";
  }
  return (
    <>
      {merge}
      {deploy}, then checks {checks}.
    </>
  );
}

/**
 * Each health check and what it last saw. Checks without a result yet show
 * as not checked.
 */
export function CheckList({
  checks,
  results,
  label = "Checks",
  className,
}: {
  checks: { url: string }[];
  results: DeployCheckResult[] | null;
  label?: string;
  className?: string;
}) {
  return (
    <ul aria-label={label} className={cx("space-y-1", className)}>
      {checks.map((c, i) => {
        const r = results?.find((x) => x.url === c.url) ?? results?.[i];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: two checks may share a URL.
          <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <Dot tone={!r ? "neutral" : r.ok ? "ok" : "danger"} />
            <span className="min-w-0 truncate text-soft" title={c.url}>
              {shortUrl(c.url)}
            </span>
            <span className="tabular shrink-0 text-muted">
              {r ? (
                <>
                  <span className={r.ok ? undefined : "text-danger"}>{checkStatusText(r)}</span>
                  {" · "}
                  {duration(r.ms)}
                </>
              ) : (
                "Not checked yet"
              )}
            </span>
            {r?.error && <span className="w-full pl-4 text-danger">{r.error}</span>}
          </li>
        );
      })}
    </ul>
  );
}
