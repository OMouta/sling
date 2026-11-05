import type { WorkflowDefinition } from "@sling/workflow";
import { ReactFlowProvider } from "@xyflow/react";
import { type ReactNode, useMemo } from "react";
import type { CatalogIndex } from "../../lib/workflow/catalog.ts";
import { fromDefinition } from "../../lib/workflow/graph.ts";
import { GraphStore, GraphStoreContext } from "../../lib/workflow/store.ts";
import { GraphCanvas } from "./Canvas.tsx";

/** A store for viewing a fixed definition, such as a version or a run's version. */
export function useReadOnlyStore(
  definition: WorkflowDefinition | undefined,
  catalog: CatalogIndex | null,
) {
  return useMemo(
    () =>
      definition && catalog
        ? new GraphStore(catalog, fromDefinition(definition, catalog), true)
        : null,
    [definition, catalog],
  );
}

export function ReadOnlyCanvas({
  store,
  onNodeClick,
  side,
}: {
  store: GraphStore;
  onNodeClick?: (nodeId: string) => void;
  /** A side panel inside the store's context, hidden on phones. */
  side?: ReactNode;
}) {
  return (
    <GraphStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">
            <GraphCanvas onNodeClick={onNodeClick} />
          </div>
          {side && (
            <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border bg-surface md:block">
              {side}
            </aside>
          )}
        </div>
      </ReactFlowProvider>
    </GraphStoreContext.Provider>
  );
}
