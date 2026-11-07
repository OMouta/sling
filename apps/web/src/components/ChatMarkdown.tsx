import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { siteName } from "../lib/research.ts";

/** A citation's link text is only its number, as in `[2](https://…)`. */
function citation(children: ReactNode): boolean {
  const only = Array.isArray(children) && children.length === 1 ? children[0] : children;
  return typeof only === "string" && /^\d{1,3}$/.test(only);
}

const components: Components = {
  // Wide tables scroll inside the reply instead of widening the page.
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, children, ...props }) =>
    citation(children) ? (
      <a
        {...props}
        target="_blank"
        rel="noreferrer"
        className="citation"
        title={siteName(props.href)}
      >
        {children}
      </a>
    ) : (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

/**
 * Chat text as GitHub-flavored Markdown: tables, task lists, strikethrough,
 * and autolinks. Raw HTML is never rendered: it shows as text, or with
 * `skipHtml` (for documents like READMEs) it's left out.
 */
export function ChatMarkdown({ children, skipHtml }: { children: string; skipHtml?: boolean }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml={skipHtml}>
      {children}
    </Markdown>
  );
}
