import type { MessageView } from "@sling/core";
import { FileText } from "lucide-react";
import { useState } from "react";
import { pagePath, siteName } from "../lib/research.ts";

/** Sources past this many wait behind "Show all". */
const SHOWN = 5;

/** The sources a reply cites, under its text, by the numbers it cites them by. */
export function ReplySources({ message }: { message: MessageView }) {
  const [all, setAll] = useState(false);
  const sources = message.trace?.sources ?? [];
  if (sources.length === 0) return null;
  const shown = all || sources.length <= SHOWN ? sources : sources.slice(0, SHOWN - 1);
  return (
    <section aria-label="Sources">
      <ol className="-mx-1.5">
        {shown.map((s) => {
          const site = siteName(s.url);
          return (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="group flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-[13px] transition-colors duration-150 hover:bg-hover"
              >
                <span className="citation">{s.n}</span>
                {s.kind === "document" ? (
                  <>
                    <FileText aria-hidden="true" size={13} className="shrink-0 text-subtle" />
                    <span className="min-w-0 truncate text-soft">{s.title}</span>
                    {s.page && <span className="shrink-0 text-xs text-subtle">page {s.page}</span>}
                  </>
                ) : (
                  <>
                    <span className="shrink-0 text-soft">{site}</span>
                    <span className="min-w-0 truncate text-subtle">
                      {s.title !== site ? s.title : pagePath(s.url)}
                    </span>
                  </>
                )}
              </a>
            </li>
          );
        })}
      </ol>
      {shown.length < sources.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-0.5 cursor-pointer text-xs text-subtle transition-colors duration-150 hover:text-text"
        >
          Show all {sources.length}
        </button>
      )}
    </section>
  );
}
