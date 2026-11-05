import { BaseEdge, type EdgeProps, getBezierPath } from "@xyflow/react";
import { memo } from "react";
import { typeColor } from "../../lib/workflow/catalog.ts";
import type { GraphEdge } from "../../lib/workflow/graph.ts";
import { useGraph } from "../../lib/workflow/store.ts";

type Tone = "default" | "selected" | "danger" | "taken";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--edge-exec)",
  selected: "var(--accent)",
  danger: "var(--danger)",
  taken: "var(--ok)",
};

/** Exec edges: thick and neutral. The arrow-shaped input handle shows the direction. */
export const ExecEdge = memo(function ExecEdge(props: EdgeProps<GraphEdge>) {
  const [path] = getBezierPath(props);
  const issue = useGraph((s) => s.decor.edgeIssues.has(props.id));
  const taken = useGraph((s) => s.decor.takenEdges.has(props.id));
  const tone: Tone = issue ? "danger" : props.selected ? "selected" : taken ? "taken" : "default";
  return (
    <BaseEdge
      id={props.id}
      path={path}
      interactionWidth={18}
      className="sling-edge-exec"
      style={{ stroke: TONE_COLOR[tone] }}
    />
  );
});

/** Data edges: thin, colored by the value's type. */
export const DataEdge = memo(function DataEdge(props: EdgeProps<GraphEdge>) {
  const [path] = getBezierPath(props);
  const issue = useGraph((s) => s.decor.edgeIssues.has(props.id));
  const stroke = issue
    ? "var(--danger)"
    : props.selected
      ? "var(--accent)"
      : typeColor(props.data?.portType);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      interactionWidth={14}
      className="sling-edge-data"
      style={{ stroke, strokeWidth: props.selected || issue ? 2.25 : 1.5 }}
    />
  );
});
