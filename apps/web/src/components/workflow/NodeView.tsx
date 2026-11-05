import type { NodeSpecView, PortSpec, ValidationIssue } from "@sling/workflow";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { type CSSProperties, memo, useMemo } from "react";
import {
  categoryColor,
  ERROR_OUTPUT,
  handleId,
  isListType,
  type PortKind,
  parseHandle,
  portsOf,
  typeColor,
} from "../../lib/workflow/catalog.ts";
import type { GraphNode } from "../../lib/workflow/graph.ts";
import { useGraph, useGraphStore } from "../../lib/workflow/store.ts";
import { cx } from "../ui.tsx";

interface PortProps {
  side: "in" | "out";
  kind: PortKind;
  name: string;
  label: string;
  type?: string;
  description?: string;
  required?: boolean;
  connected: boolean;
  issue: boolean;
  connectable: boolean;
}

function Port({
  side,
  kind,
  name,
  label,
  type,
  description,
  required,
  connected,
  issue,
  connectable,
}: PortProps) {
  const hint =
    kind === "exec"
      ? `${name} (exec)`
      : `${name}: ${type ?? "any"}${required ? " (required)" : ""}${description ? `\n${description}` : ""}`;
  return (
    <div
      className={cx(
        "sling-port",
        side === "in" ? "is-in" : "is-out",
        kind === "exec" ? "is-exec" : "is-data",
        issue && "has-issue",
        name === ERROR_OUTPUT.name && side === "out" && "is-error",
      )}
      title={hint}
      data-port={handleId(kind, name)}
    >
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={handleId(kind, name)}
        isConnectable={connectable}
        title={hint}
        className={cx(
          "sling-handle",
          kind === "exec" ? "sling-handle-exec" : "sling-handle-data",
          connected && "is-connected",
          type && isListType(type) && "is-list",
        )}
        style={kind === "data" ? ({ "--port": typeColor(type) } as CSSProperties) : undefined}
      />
      <span className="sling-port-label">
        {label}
        {required && <span className="text-danger">*</span>}
      </span>
    </div>
  );
}

function issueOnPort(issues: ValidationIssue[] | undefined, port: string): boolean {
  return issues?.some((i) => i.port === port) ?? false;
}

function KnownPorts({
  spec,
  config,
  connected,
  issues,
  connectable,
}: {
  spec: NodeSpecView;
  config: Record<string, unknown>;
  connected: ReadonlySet<string> | undefined;
  issues: ValidationIssue[] | undefined;
  connectable: boolean;
}) {
  const ports = useMemo(() => portsOf(spec, config), [spec, config]);
  const has = (side: "in" | "out", kind: PortKind, name: string) =>
    connected?.has(`${side}:${handleId(kind, name)}`) ?? false;
  // The error data output only matters on the failure path, so it shows once that's wired.
  const errorWired = has("out", "exec", ERROR_OUTPUT.name) || has("out", "data", ERROR_OUTPUT.name);
  const outputs = ports.outputs.filter((p) => p !== ERROR_OUTPUT || errorWired);
  const dataPort = (side: "in" | "out", p: PortSpec) => (
    <Port
      key={`d:${p.name}`}
      side={side}
      kind="data"
      name={p.name}
      label={p.label ?? p.name}
      type={p.type}
      description={p.description}
      required={side === "in" && p.required}
      connected={has(side, "data", p.name)}
      issue={issueOnPort(issues, p.name)}
      connectable={connectable}
    />
  );
  return (
    <div className="sling-node-ports">
      <div className="sling-port-col">
        {ports.execIn && (
          <Port
            side="in"
            kind="exec"
            name="in"
            label=""
            connected={has("in", "exec", "in")}
            issue={issueOnPort(issues, "in")}
            connectable={connectable}
          />
        )}
        {ports.inputs.map((p) => dataPort("in", p))}
      </div>
      <div className="sling-port-col">
        {ports.execOut.map((p) => (
          <Port
            key={`x:${p.name}`}
            side="out"
            kind="exec"
            name={p.name}
            label={p.label ?? p.name}
            connected={has("out", "exec", p.name)}
            issue={issueOnPort(issues, p.name)}
            connectable={connectable}
          />
        ))}
        {outputs.map((p) => dataPort("out", p))}
      </div>
    </div>
  );
}

/** Ports of a node whose type the catalog doesn't know, rebuilt from its edges. */
function UnknownPorts({ connected }: { connected: ReadonlySet<string> | undefined }) {
  const handles = [...(connected ?? [])].map((key) => {
    const [side, ...rest] = key.split(":");
    return { side: side as "in" | "out", handle: parseHandle(rest.join(":")) };
  });
  const col = (side: "in" | "out") =>
    handles
      .filter((h) => h.side === side && h.handle)
      .map(({ handle }) => (
        <Port
          key={`${handle?.kind}:${handle?.port}`}
          side={side}
          kind={handle?.kind ?? "data"}
          name={handle?.port ?? ""}
          label={handle?.port ?? ""}
          connected
          issue={false}
          connectable={false}
        />
      ));
  return (
    <div className="sling-node-ports">
      <div className="sling-port-col">{col("in")}</div>
      <div className="sling-port-col">{col("out")}</div>
    </div>
  );
}

/**
 * A workflow node on the canvas. Memoized, and it subscribes only to its own
 * slices of the store, so editing or dragging one node leaves the rest alone.
 */
export const NodeView = memo(function NodeView({ id, data, selected }: NodeProps<GraphNode>) {
  const store = useGraphStore();
  const spec = store.catalog.byType.get(data.type);
  const connected = useGraph((s) => s.connected.get(id));
  const issues = useGraph((s) => s.decor.nodeIssues.get(id));
  const status = useGraph((s) => s.decor.statuses.get(id));
  const showingRun = useGraph((s) => s.decor.statuses.size > 0);
  const connectable = !store.readOnly;
  const title = data.label || spec?.title || data.type;
  const subtitle = data.label ? (spec?.title ?? data.type) : data.type;

  return (
    <div
      className={cx(
        "sling-node",
        selected && "is-selected",
        issues && "has-issues",
        !spec && "is-unknown",
        showingRun && !status && "is-idle",
      )}
      style={{ "--cat": categoryColor(spec?.category ?? "") } as CSSProperties}
      data-status={status}
      data-testid={`node-${id}`}
    >
      <div className="sling-node-header">
        <div className="min-w-0 flex-1">
          <div className="sling-node-title">{title}</div>
          <div className="sling-node-sub">{spec ? subtitle : `Unknown type ${data.type}`}</div>
        </div>
        {issues && (
          <span
            className="sling-node-badge is-issue"
            title={issues.map((i) => i.message).join("\n")}
            role="img"
            aria-label={`${issues.length} problem${issues.length === 1 ? "" : "s"}`}
          >
            {issues.length}
          </span>
        )}
        {status && <span className={`sling-node-badge is-status status-${status}`}>{status}</span>}
      </div>
      {spec ? (
        <KnownPorts
          spec={spec}
          config={data.config}
          connected={connected}
          issues={issues}
          connectable={connectable}
        />
      ) : (
        <UnknownPorts connected={connected} />
      )}
    </div>
  );
});
