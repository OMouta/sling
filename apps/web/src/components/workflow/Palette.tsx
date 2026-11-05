import type { NodeSpecView } from "@sling/workflow";
import { useReactFlow } from "@xyflow/react";
import { useMemo, useState } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoryColor } from "../../lib/workflow/catalog.ts";
import { useGraphStore } from "../../lib/workflow/store.ts";
import { Input } from "../ui.tsx";
import { NODE_DND_TYPE } from "./Canvas.tsx";

function matches(spec: NodeSpecView, q: string): boolean {
  if (!q) return true;
  const hay =
    `${spec.title} ${spec.type} ${spec.description} ${spec.connector ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/** Node types by category. Drag one onto the canvas, or click to add it in the middle. */
export function Palette() {
  const store = useGraphStore();
  const rf = useReactFlow();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const visible = store.catalog.nodes.filter((n) => matches(n, query.trim()));
    const known = new Set<string>(CATEGORY_ORDER);
    const cats = [
      ...CATEGORY_ORDER,
      ...new Set(visible.map((n) => n.category).filter((c) => !known.has(c))),
    ];
    return cats
      .map((cat) => ({
        cat,
        nodes: visible
          .filter((n) => n.category === cat)
          .sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .filter((g) => g.nodes.length > 0);
  }, [store.catalog.nodes, query]);

  const addAtCenter = (spec: NodeSpecView) => {
    const el = document.querySelector(".sling-canvas");
    const box = el?.getBoundingClientRect();
    const at = rf.screenToFlowPosition({
      x: box ? box.left + box.width / 2 : window.innerWidth / 2,
      y: box ? box.top + box.height / 2 : window.innerHeight / 2,
    });
    const offset = (store.get().graph.nodes.length % 5) * 24;
    store.addNode(spec, { x: at.x - 110 + offset, y: at.y - 30 + offset });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <Input
          type="search"
          aria-label="Search nodes"
          placeholder="Search nodes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {groups.length === 0 && <p className="text-xs text-muted">No nodes match.</p>}
        {groups.map(({ cat, nodes }) => (
          <section key={cat}>
            <h3 className="section-label mb-2 flex items-center gap-2">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: categoryColor(cat) }}
              />
              {CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] ?? cat}
            </h3>
            <ul className="space-y-1">
              {nodes.map((spec) => (
                <li key={spec.type}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NODE_DND_TYPE, spec.type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addAtCenter(spec)}
                    title={`${spec.description || spec.title}\nDrag onto the canvas, or click to add.`}
                    className="pressable w-full cursor-grab rounded-lg bg-surface-2 px-2.5 py-1.5 text-left shadow-raised hover:shadow-raised-hover active:cursor-grabbing"
                  >
                    <span className="block truncate text-[13px]">{spec.title}</span>
                    <span className="block truncate font-mono text-[11px] text-subtle">
                      {spec.type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
