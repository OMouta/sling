import type { WorkflowDefinition, WorkflowDetailView } from "@sling/workflow";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type DraftConflict, DraftConflictError, qk, workflowApi } from "../workflowApi.ts";
import { toDefinition } from "./graph.ts";
import type { GraphStore } from "./store.ts";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export const AUTOSAVE_DELAY_MS = 800;

export interface Autosave {
  status: SaveStatus;
  error: unknown;
  /** The draft as saved somewhere else, while this editor's changes wait on a decision. */
  conflict: DraftConflict | null;
  /** The draft revision the canvas is based on. */
  revision: () => number;
  /** Whether anything on the canvas isn't saved yet, or a conflict is unresolved. */
  pending: () => boolean;
  /** Saves now if anything changed, and waits for saves in flight. Rejects if the save fails. */
  flush: () => Promise<void>;
  /** Forgets unsaved changes and any conflict, for when the canvas is about to be replaced. */
  discard: () => void;
  /** Resolves a conflict by saving the canvas over the draft that's there now. */
  overwrite: () => Promise<void>;
  /** Saves a whole definition, such as a restored version, over the draft the canvas is based on. */
  replace: (def: WorkflowDefinition) => Promise<void>;
  /** Takes up a conflict that another request ran into, such as a publish. */
  conflicted: (conflict: DraftConflict) => void;
}

interface Unsaved {
  definition: WorkflowDefinition;
  revision: number;
}

/**
 * Drafts whose save didn't go through as their editor closed, by workflow.
 * The editor opens on one of these and saves it again, so a failure there is
 * shown instead of lost. Kept in memory only, for this page's lifetime.
 */
const unsavedDrafts = new Map<string, Unsaved>();

/** The changes a closed editor couldn't save, if any. */
export function unsavedDraft(workflowId: string): Unsaved | null {
  return unsavedDrafts.get(workflowId) ?? null;
}

/**
 * Saves the draft through `PUT /api/workflows/:id/draft` a moment after the
 * last change. Saves run one at a time, in order, and a change made during a
 * save is saved after it. Each save names the draft revision it's based on;
 * when the draft has changed somewhere else since, the server refuses it and
 * saving stops until the conflict is resolved. Pending changes are saved
 * when the editor closes, and kept for the next time it opens if that fails.
 *
 * `revision` is the draft revision the canvas starts from. With `unsaved`,
 * the canvas holds changes that aren't saved yet, and they're saved at once.
 */
export function useAutosave(
  store: GraphStore,
  workflowId: string,
  start: { revision: number; unsaved: boolean },
): Autosave {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>(start.unsaved ? "dirty" : "saved");
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const api = useRef<Omit<Autosave, "status" | "error" | "conflict">>({
    revision: () => start.revision,
    pending: () => false,
    flush: async () => {},
    discard: () => {},
    overwrite: async () => {},
    replace: async () => {},
    conflicted: () => {},
  });
  const { revision: startRevision, unsaved: startUnsaved } = start;

  useEffect(() => {
    // The graph revision last saved. Below any real revision when the canvas starts unsaved.
    let saved = startUnsaved ? -1 : store.get().graph.revision;
    // The draft revision the canvas is based on.
    let base = startRevision;
    let clash: DraftConflict | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain: Promise<void> = Promise.resolve();
    let live = true;
    const dirty = () => store.get().graph.revision !== saved;
    const report = (s: SaveStatus) => live && setStatus(s);
    const enterConflict = (c: DraftConflict) => {
      clearTimeout(timer);
      timer = undefined;
      clash = c;
      if (live) setConflict(c);
      report("conflict");
    };
    const leaveConflict = () => {
      clash = null;
      if (live) setConflict(null);
    };

    const write = async (def: WorkflowDefinition) => {
      const res = await workflowApi.saveDraft(workflowId, def, base);
      base = res.draftRevision;
      unsavedDrafts.delete(workflowId);
      qc.setQueryData<WorkflowDetailView>(qk.workflow(workflowId), (d) =>
        d
          ? {
              ...d,
              draft: def,
              draftRevision: res.draftRevision,
              hasUnpublishedChanges: res.hasUnpublishedChanges,
            }
          : d,
      );
    };

    const failed = (err: unknown) => {
      if (err instanceof DraftConflictError) {
        enterConflict(err.conflict);
        return;
      }
      if (live) setError(err);
      report("error");
    };

    const saveOnce = async () => {
      if (clash) throw new DraftConflictError(clash);
      if (!dirty()) return;
      const { graph } = store.get();
      const revision = graph.revision;
      report("saving");
      try {
        await write(toDefinition(graph));
      } catch (err) {
        failed(err);
        throw err;
      }
      saved = Math.max(saved, revision);
      if (live) setError(null);
      report(dirty() ? "dirty" : "saved");
    };

    const queue = (task: () => Promise<void>): Promise<void> => {
      clearTimeout(timer);
      timer = undefined;
      const run = chain.then(task);
      chain = run.catch(() => {});
      return run;
    };
    const save = () => queue(saveOnce);

    const unsubscribe = store.subscribe(() => {
      if (!dirty() || clash) return;
      setStatus((s) => (s === "saving" ? s : "dirty"));
      clearTimeout(timer);
      timer = setTimeout(() => void save().catch(() => {}), AUTOSAVE_DELAY_MS);
    });
    if (startUnsaved) timer = setTimeout(() => void save().catch(() => {}), 0);

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty() || clash) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);

    api.current = {
      revision: () => base,
      pending: () => dirty() || clash !== null,
      flush: save,
      discard: () => {
        clearTimeout(timer);
        timer = undefined;
        saved = store.get().graph.revision;
        unsavedDrafts.delete(workflowId);
        leaveConflict();
        if (live) setError(null);
        report("saved");
      },
      overwrite: () => {
        if (!clash) return Promise.resolve();
        base = clash.revision;
        leaveConflict();
        // Saved even with no edits since the last save: the canvas is what goes in.
        saved = -1;
        return save();
      },
      replace: (def) =>
        queue(async () => {
          if (clash) throw new DraftConflictError(clash);
          report("saving");
          try {
            await write(def);
          } catch (err) {
            failed(err);
            throw err;
          }
          saved = store.get().graph.revision;
          if (live) setError(null);
          report("saved");
        }),
      conflicted: enterConflict,
    };

    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("beforeunload", beforeUnload);
      live = false;
      if (!dirty() && !clash) return;
      const keep: Unsaved = { definition: toDefinition(store.get().graph), revision: base };
      if (clash) {
        unsavedDrafts.set(workflowId, keep);
        return;
      }
      void save().catch(() => unsavedDrafts.set(workflowId, keep));
    };
  }, [store, workflowId, qc, startRevision, startUnsaved]);

  return {
    status,
    error,
    conflict,
    revision: () => api.current.revision(),
    pending: () => api.current.pending(),
    flush: () => api.current.flush(),
    discard: () => api.current.discard(),
    overwrite: () => api.current.overwrite(),
    replace: (def) => api.current.replace(def),
    conflicted: (c) => api.current.conflicted(c),
  };
}
