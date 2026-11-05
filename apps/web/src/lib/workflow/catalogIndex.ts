import { useMemo } from "react";
import { useCatalog } from "../workflowApi.ts";
import { type CatalogIndex, indexCatalog } from "./catalog.ts";

/**
 * The node catalog, indexed. Kept apart from `workflowApi.ts` so pages that
 * don't draw a canvas don't load the workflow contracts and their schemas.
 */
export function useCatalogIndex() {
  const q = useCatalog();
  const index = useMemo<CatalogIndex | null>(
    () => (q.data ? indexCatalog(q.data) : null),
    [q.data],
  );
  return { ...q, index };
}
