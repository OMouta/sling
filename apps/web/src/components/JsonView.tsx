import { useState } from "react";
import { Button, cx } from "./ui.tsx";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be refused; the text is still on screen.
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function preview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).length}}`;
  return "";
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted">null</span>;
  if (typeof value === "string") {
    return <span className="break-all whitespace-pre-wrap text-ok">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") return <span className="text-accent-text">{value}</span>;
  if (typeof value === "boolean") return <span className="text-warn">{String(value)}</span>;
  return <span className="text-muted">{String(value)}</span>;
}

function Tree({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const isBranch = value !== null && typeof value === "object";
  const label = name !== null && <span className="text-muted">{name}: </span>;
  if (!isBranch) {
    return (
      <div className="pl-4">
        {label}
        <Scalar value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <details open={depth < 2} className="pl-4 [&>summary]:-ml-4">
      <summary className="cursor-pointer select-none">
        {label}
        <span className="text-muted">{preview(value)}</span>
      </summary>
      {entries.length === 0 ? (
        <div className="pl-4 text-muted">empty</div>
      ) : (
        entries.map(([k, v]) => <Tree key={k} name={k} value={v} depth={depth + 1} />)
      )}
    </details>
  );
}

/** A collapsible JSON tree with a copy button. */
export function JsonView({
  value,
  title,
  className,
}: {
  value: unknown;
  title?: string;
  className?: string;
}) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return (
    <div className={cx("rounded-lg bg-field shadow-field", className)}>
      {title && (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="section-label">{title}</span>
          <CopyButton text={text} />
        </div>
      )}
      <div className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-5">
        <Tree name={null} value={value} depth={0} />
      </div>
    </div>
  );
}
