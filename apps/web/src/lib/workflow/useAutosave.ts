import type { WorkflowDetailView } from "@sling/workflow";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { qk, workflowApi } from "../workflowApi.ts";
import { toDefinition } from "./graph.ts";
import type { GraphStore } from "./store.ts";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export const AUTOSAVE_DELAY_MS = 800;

export interface Autosave {
  status: SaveStatus;
  error: unknown;
  /** Saves now if anything changed, and waits for saves in flight. Rejects if the save fails. */
  flush: () => Promise<void>;
  /** Forgets unsaved changes, for when the draft is about to be replaced. */
  discard: () => void;
}

/**
 * Saves the draft through `PUT /api/workflows/:id/draft` a moment after the
 * last change. Saves run one at a time, in order, and a change made during a
 * save is saved after it. Pending changes are saved when the editor closes.
 */
export function useAutosave(store: GraphStore, workflowId: string): Autosave {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<unknown>(null);
  const api = useRef<Pick<Autosave, "flush" | "discard">>({
    flush: async () => {},
    discard: () => {},
  });

  useEffect(() => {
    let saved = store.get().graph.revision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain: Promise<void> = Promise.resolve();
    let live = true;
    const dirty = () => store.get().graph.revision !== saved;
    const report = (s: SaveStatus) => live && setStatus(s);

    const saveOnce = async () => {
      if (!dirty()) return;
      const { graph } = store.get();
      const revision = graph.revision;
      const def = toDefinition(graph);
      report("saving");
      try {
        await workflowApi.saveDraft(workflowId, def);
      } catch (err) {
        if (live) setError(err);
        report("error");
        throw err;
      }
      saved = Math.max(saved, revision);
      if (live) setError(null);
      qc.setQueryData<WorkflowDetailView>(qk.workflow(workflowId), (d) =>
        d ? { ...d, draft: def, hasUnpublishedChanges: true } : d,
      );
      report(dirty() ? "dirty" : "saved");
    };

    const save = (): Promise<void> => {
      clearTimeout(timer);
      timer = undefined;
      const run = chain.then(saveOnce);
      chain = run.catch(() => {});
      return run;
    };

    const unsubscribe = store.subscribe(() => {
      if (!dirty()) return;
      setStatus((s) => (s === "saving" ? s : "dirty"));
      clearTimeout(timer);
      timer = setTimeout(() => void save().catch(() => {}), AUTOSAVE_DELAY_MS);
    });

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);

    api.current = {
      flush: save,
      discard: () => {
        clearTimeout(timer);
        timer = undefined;
        saved = store.get().graph.revision;
        report("saved");
      },
    };

    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", beforeUnload);
      if (dirty()) void save().catch(() => {});
      live = false;
    };
  }, [store, workflowId, qc]);

  return {
    status,
    error,
    flush: () => api.current.flush(),
    discard: () => api.current.discard(),
  };
}
