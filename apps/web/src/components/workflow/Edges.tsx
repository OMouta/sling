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

/** Arrowheads for exec edges, one per color. Render once per canvas. */
export function EdgeMarkers() {
  return (
    <svg className="sling-markers" aria-hidden="true">
      <defs>
        {(Object.keys(TONE_COLOR) as Tone[]).map((tone) => (
          <marker
            key={tone}
            id={`sling-arrow-${tone}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="11"
            markerHeight="11"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: TONE_COLOR[tone] }} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/** Exec edges: thick, neutral, with an arrowhead. */
export const ExecEdge = memo(function ExecEdge(props: EdgeProps<GraphEdge>) {
  const [path] = getBezierPath(props);
  const issue = useGraph((s) => s.decor.edgeIssues.has(props.id));
  const taken = useGraph((s) => s.decor.takenEdges.has(props.id));
  const tone: Tone = issue ? "danger" : props.selected ? "selected" : taken ? "taken" : "default";
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={`url(#sling-arrow-${tone})`}
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
