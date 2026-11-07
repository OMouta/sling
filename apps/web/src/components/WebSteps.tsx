import type { ToolStep } from "@sling/core";
import { ChevronRight, Globe, Search, X } from "lucide-react";
import { useState } from "react";
import { siteName } from "../lib/research.ts";
import { cx, Spinner } from "./ui.tsx";

function parse<T>(text: string | null): T | null {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

const field = (step: ToolStep, key: string) => {
  const input = step.input && typeof step.input === "object" ? step.input : {};
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
};

function StepIcon({ step, icon: Icon }: { step: ToolStep; icon: typeof Globe }) {
  if (step.status === "running") return <Spinner className="size-3.5" />;
  if (step.status === "error") {
    return <X aria-hidden="true" size={14} className="shrink-0 text-danger" />;
  }
  return <Icon aria-hidden="true" size={14} className="shrink-0 text-subtle" />;
}

/** A web search or a page read, from any provider. */
export function WebStep({ step }: { step: ToolStep }) {
  return step.name === "web_search" ? <SearchStep step={step} /> : <PageStep step={step} />;
}

/** A search: its query, and its results as links on a click. */
function SearchStep({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const query = field(step, "query");
  const results = (
    parse<{ results?: { title?: string; url?: string }[] }>(step.output)?.results ?? []
  ).filter((r): r is { title?: string; url: string } => Boolean(r.url));
  const running = step.status === "running";
  const failed = step.status === "error";
  const verb = running ? "Searching the web for" : failed ? "Couldn't search for" : "Searched for";
  const canOpen = results.length > 0;
  return (
    <div>
      <button
        type="button"
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-[13px] text-muted transition-colors duration-150 hover:text-soft disabled:cursor-default"
      >
        <StepIcon step={step} icon={Search} />
        <span
          className={cx("min-w-0 truncate", running && "text-shimmer", failed && "text-danger")}
        >
          {verb} {query ? <span className={cx(!failed && "text-soft")}>“{query}”</span> : "the web"}
        </span>
        {canOpen && (
          <span className="tabular shrink-0 text-subtle">
            {results.length} {results.length === 1 ? "result" : "results"}
          </span>
        )}
        {canOpen && (
          <ChevronRight
            aria-hidden="true"
            size={13}
            className={cx(
              "shrink-0 text-subtle opacity-0 transition duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        )}
      </button>
      {open && (
        <ul className="mt-1.5 ml-[7px] space-y-0.5 border-l border-border pl-4">
          {results.map((r) => (
            <li key={r.url}>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-baseline gap-2 text-[13px] leading-6 text-soft transition-colors duration-150 hover:text-text"
              >
                <span className="min-w-0 truncate">{r.title || siteName(r.url)}</span>
                <span className="shrink-0 text-xs text-subtle">{siteName(r.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A page the assistant opened: its title and site, linking to it. */
function PageStep({ step }: { step: ToolStep }) {
  const url = field(step, "url");
  const site = siteName(url);
  const title = parse<{ title?: string }>(step.output)?.title?.trim();
  const running = step.status === "running";
  const failed = step.status === "error";
  const label = running ? "Reading" : failed ? "Couldn't open" : "Read";
  const body = (
    <>
      <span className={cx("min-w-0 truncate", running && "text-shimmer", failed && "text-danger")}>
        {label} <span className={cx(!failed && "text-soft")}>{title || site || "a page"}</span>
      </span>
      {title && site && <span className="shrink-0 text-subtle">{site}</span>}
    </>
  );
  return (
    <p className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
      <StepIcon step={step} icon={Globe} />
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-2 transition-colors duration-150 hover:text-soft"
        >
          {body}
        </a>
      ) : (
        body
      )}
    </p>
  );
}
