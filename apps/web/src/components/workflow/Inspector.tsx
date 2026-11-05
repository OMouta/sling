import type { InstallationView } from "@sling/core";
import { expressionSource, isExpression, type NodeSpecView, toExpression } from "@sling/workflow";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useRef } from "react";
import { type FormField, formFields } from "../../lib/schemaForm.ts";
import { portsOf } from "../../lib/workflow/catalog.ts";
import {
  type AvailableFields,
  availableFields,
  type FieldPath,
} from "../../lib/workflow/expressions.ts";
import * as g from "../../lib/workflow/graph.ts";
import { useGraph, useGraphStore } from "../../lib/workflow/store.ts";
import { useInstallations } from "../../lib/workflowApi.ts";
import { type FieldOverride, SchemaForm } from "../SchemaForm.tsx";
import { Badge, Button, cx, Input, Select, Spinner } from "../ui.tsx";

/** Selected node and edge IDs as one string, so the selector result is stable. */
function selectionKey(s: g.GraphState): string {
  return `${g.selectedNodeIds(s).join(",")}|${g.selectedEdgeIds(s).join(",")}`;
}

/**
 * Settings for the selected node. With nothing selected it shows `empty`,
 * typically the workflow's own settings.
 */
export function Inspector({
  empty,
  nodeExtra,
  readOnly,
}: {
  empty: ReactNode;
  /** Extra content for a node, such as its webhook URL. */
  nodeExtra?: (nodeId: string, spec: NodeSpecView | undefined) => ReactNode;
  readOnly?: boolean;
}) {
  const store = useGraphStore();
  const key = useGraph((s) => selectionKey(s.graph));
  const [nodePart = "", edgePart = ""] = key.split("|");
  const nodeIds = nodePart ? nodePart.split(",") : [];
  const edgeIds = edgePart ? edgePart.split(",") : [];
  const editable = !readOnly && !store.readOnly;

  if (nodeIds.length === 1 && nodeIds[0]) {
    return (
      <NodeInspector key={nodeIds[0]} nodeId={nodeIds[0]} editable={editable} extra={nodeExtra} />
    );
  }
  if (nodeIds.length > 1 || edgeIds.length > 0) {
    const what =
      nodeIds.length > 0
        ? `${nodeIds.length} nodes${edgeIds.length ? ` and ${edgeIds.length} connections` : ""}`
        : `${edgeIds.length} connection${edgeIds.length === 1 ? "" : "s"}`;
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm">{what} selected.</p>
        {editable && (
          <Button variant="danger" size="sm" onClick={() => store.update(g.deleteSelection)}>
            Delete
          </Button>
        )}
      </div>
    );
  }
  return <>{empty}</>;
}

function NodeInspector({
  nodeId,
  editable,
  extra,
}: {
  nodeId: string;
  editable: boolean;
  extra?: (nodeId: string, spec: NodeSpecView | undefined) => ReactNode;
}) {
  const store = useGraphStore();
  const data = useGraph((s) => g.nodeById(s.graph, nodeId)?.data);
  const issues = useGraph((s) => s.decor.nodeIssues.get(nodeId));
  const spec = data ? store.spec(data.type) : undefined;
  const fields = useMemo(() => (spec ? formFields(spec.configSchema) : []), [spec]);

  if (!data) return null;
  const setConfig = (config: Record<string, unknown>, key: string) =>
    store.update((s) =>
      g.updateConfig(s, store.catalog, nodeId, config, `config:${nodeId}:${key}`),
    );

  const override = (field: FormField, value: unknown, set: (v: unknown) => void) =>
    spec ? fieldOverride(spec, nodeId, field, value, set, editable) : null;

  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-medium">{spec?.title ?? "Unknown node"}</h2>
          {spec && <Badge>{spec.category}</Badge>}
        </div>
        <p className="font-mono text-xs text-muted">{data.type}</p>
        {spec?.description && <p className="text-sm text-muted">{spec.description}</p>}
        {!spec && (
          <p className="text-sm text-danger">
            This server doesn't know this node type. Publishing will fail until it's removed.
          </p>
        )}
        {spec && spec.version !== data.version && (
          <p className="text-sm text-warn">
            Written for version {data.version} of this node; the server has version {spec.version}.
          </p>
        )}
      </div>

      {issues && (
        <ul className="space-y-1 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          {issues.map((i) => (
            <li key={`${i.code}:${i.port ?? ""}:${i.edgeId ?? ""}:${i.message}`}>{i.message}</li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <label htmlFor={`label-${nodeId}`} className="text-sm font-medium">
          Label
        </label>
        <Input
          id={`label-${nodeId}`}
          value={data.label}
          placeholder={spec?.title}
          maxLength={120}
          disabled={!editable}
          onChange={(e) => store.update((s) => g.updateLabel(s, nodeId, e.target.value))}
        />
      </div>

      {extra?.(nodeId, spec)}

      {spec && (
        <section className="space-y-3">
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Settings</h3>
          <SchemaForm
            fields={fields}
            value={data.config}
            onChange={setConfig}
            override={override}
            disabled={!editable}
          />
        </section>
      )}

      {spec && <PortList spec={spec} config={data.config} nodeId={nodeId} />}

      {editable && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => store.update((s) => g.removeElements(s, [nodeId]))}
        >
          Delete node
        </Button>
      )}
    </div>
  );
}

function fieldOverride(
  spec: NodeSpecView,
  nodeId: string,
  field: FormField,
  value: unknown,
  set: (v: unknown) => void,
  editable: boolean,
): FieldOverride | null {
  if (spec.installationFields.includes(field.key)) {
    return {
      control: (
        <InstallationSelect
          connector={spec.connector}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => set(v || undefined)}
          disabled={!editable}
          label={field.label}
        />
      ),
    };
  }
  if (!spec.expressionFields.includes(field.key)) return null;
  const expr = isExpression(value);
  return {
    accessory: (
      <button
        type="button"
        role="switch"
        aria-checked={expr}
        aria-label={`Use an expression for ${field.label}`}
        title={expr ? "Switch to a fixed value" : "Switch to a JSONata expression"}
        disabled={!editable}
        onClick={() =>
          set(expr ? literalFrom(value as string, field) : toExpression(sourceFrom(value)))
        }
        className={cx(
          "h-6 rounded-md border px-1.5 font-mono text-xs",
          expr
            ? "border-accent bg-accent/10 text-accent"
            : "border-border text-muted hover:text-text",
        )}
      >
        {"{{ }}"}
      </button>
    ),
    control: expr ? (
      <ExpressionEditor
        nodeId={nodeId}
        label={field.label}
        value={value as string}
        onChange={set}
        disabled={!editable}
      />
    ) : undefined,
  };
}

/** JSONata source equal to a literal value, so switching modes keeps its meaning. */
function sourceFrom(value: unknown): string {
  if (value === undefined || value === "") return "";
  return JSON.stringify(value);
}

/** The literal behind an expression, if it is one; otherwise empty. */
function literalFrom(value: string, field: FormField): unknown {
  const src = expressionSource(value);
  try {
    const parsed: unknown = JSON.parse(src);
    const ok =
      (field.kind === "number" && typeof parsed === "number") ||
      (field.kind === "boolean" && typeof parsed === "boolean") ||
      ((field.kind === "string" || field.kind === "textarea" || field.kind === "enum") &&
        typeof parsed === "string") ||
      field.kind === "json";
    if (ok) return parsed;
  } catch {
    // Not a literal; fall through.
  }
  return field.kind === "string" || field.kind === "textarea" ? "" : undefined;
}

function ExpressionEditor({
  nodeId,
  label,
  value,
  onChange,
  disabled,
}: {
  nodeId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const store = useGraphStore();
  const edges = useGraph((s) => s.graph.edges);
  const nodeCount = useGraph((s) => s.graph.nodes.length);
  const area = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the graph's shape changes, not on every move.
  const fields = useMemo(
    () => availableFields(store.get().graph, store.catalog, nodeId),
    [store, nodeId, edges, nodeCount],
  );
  const source = expressionSource(value);

  const insert = (path: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? source.length;
    const end = el?.selectionEnd ?? source.length;
    const next = source.slice(0, start) + path + source.slice(end);
    onChange(toExpression(next));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + path.length, start + path.length);
    });
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-accent/50 bg-surface focus-within:border-accent">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 font-mono text-[11px] text-muted">
          <span>{"={{"}</span>
          <span>JSONata</span>
        </div>
        <textarea
          ref={area}
          aria-label={`${label} expression`}
          rows={3}
          spellCheck={false}
          disabled={disabled}
          value={source}
          placeholder="inputs.value.subject"
          onChange={(e) => onChange(toExpression(e.target.value))}
          className="block w-full resize-y bg-transparent px-2 py-1.5 font-mono text-xs text-text outline-none placeholder:text-muted"
        />
        <div className="border-t border-border px-2 py-1 font-mono text-[11px] text-muted">
          {"}}"}
        </div>
      </div>
      <FieldList fields={fields} onPick={insert} disabled={disabled} />
    </div>
  );
}

function FieldList({
  fields,
  onPick,
  disabled,
}: {
  fields: AvailableFields;
  onPick: (path: string) => void;
  disabled: boolean;
}) {
  const group = (title: string, list: FieldPath[], empty: string) => (
    <div>
      <p className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{title}</p>
      {list.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {list.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                disabled={disabled}
                title={`${f.type}${f.description ? ` · ${f.description}` : ""}`}
                onClick={() => onPick(f.path)}
                className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] hover:border-accent"
              >
                {f.path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="space-y-2 rounded-lg bg-surface-2/60 p-2">
      {group("Inputs", fields.inputs, "Connect a data input to use its fields here.")}
      {group("Trigger", fields.trigger, "No trigger yet.")}
      {group(
        "Variables",
        fields.vars.length ? fields.vars : [{ path: "vars", type: "object" }],
        "",
      )}
    </div>
  );
}

function InstallationSelect({
  connector,
  value,
  onChange,
  disabled,
  label,
}: {
  connector: string | null;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  label: string;
}) {
  const installations = useInstallations();
  if (installations.isPending) return <Spinner />;
  const options = (installations.data ?? []).filter(
    (i: InstallationView) => !connector || i.connectorId === connector,
  );
  if (options.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">
        No {connector ?? "connector"} installations yet.{" "}
        <Link to="/connectors" className="text-accent hover:underline">
          Add one under Connectors
        </Link>
        .
      </p>
    );
  }
  const known = options.some((o) => o.id === value);
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose an installation</option>
      {value && !known && <option value={value}>Unknown ({value})</option>}
      {options.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
          {i.enabled ? "" : " (disabled)"}
        </option>
      ))}
    </Select>
  );
}

function PortList({
  spec,
  config,
  nodeId,
}: {
  spec: NodeSpecView;
  config: Record<string, unknown>;
  nodeId: string;
}) {
  const connected = useGraph((s) => s.connected.get(nodeId));
  const ports = useMemo(() => portsOf(spec, config), [spec, config]);
  if (ports.inputs.length === 0 && spec.outputs.length === 0) return null;
  const row = (name: string, type: string, side: "in" | "out", required?: boolean) => (
    <li key={`${side}:${name}`} className="flex items-center gap-2 text-xs">
      <span className="font-mono">{name}</span>
      <span className="text-muted">{type}</span>
      {required && <span className="text-danger">required</span>}
      <span className="ml-auto text-muted">
        {connected?.has(`${side}:d:${name}`) ? "connected" : ""}
      </span>
    </li>
  );
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Data ports</h3>
      {ports.inputs.length > 0 && (
        <ul className="space-y-1">
          {ports.inputs.map((p) => row(p.name, p.type, "in", p.required))}
        </ul>
      )}
      {spec.outputs.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-2">
          {spec.outputs.map((p) => row(p.name, p.type, "out"))}
        </ul>
      )}
    </section>
  );
}
