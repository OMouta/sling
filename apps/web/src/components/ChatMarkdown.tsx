import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Wide tables scroll inside the reply instead of widening the page.
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
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
