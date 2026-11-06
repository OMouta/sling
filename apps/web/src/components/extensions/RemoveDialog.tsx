import type { ExtensionView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plug, Workflow } from "lucide-react";
import { extensionApi, forgetExtension, useExtension } from "../../lib/extensionApi.ts";
import { plural } from "../../lib/format.ts";
import { Badge, Button, Dialog, ErrorText, Skeleton } from "../ui.tsx";

/** Lists what uses an extension before it goes, since its installations go with it. */
export function RemoveDialog({ ext, onClose }: { ext: ExtensionView; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useExtension(ext.id);
  const d = detail.data;
  const del = useMutation({
    mutationFn: () => extensionApi.remove(ext.id),
    onSuccess: () => {
      onClose();
      forgetExtension(qc, ext.id);
    },
  });
  const unused = d && d.installations.length === 0 && d.workflows.length === 0;

  return (
    <Dialog
      title={`Remove ${ext.name}?`}
      onClose={onClose}
      footer={
        <>
          <ErrorText error={del.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={del.isPending} disabled={!d} onClick={() => del.mutate()}>
            Remove
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px] leading-5 text-soft">
        <p>
          Its connectors, nodes, and templates are removed from Sling.
          {unused && " Nothing uses it."}
        </p>
        <ErrorText error={detail.error} />
        {!d && !detail.error && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
        {d && d.installations.length > 0 && (
          <section>
            <p>
              {plural(d.installations.length, "installation")} go with it, with their stored
              credentials:
            </p>
            <ul aria-label="Installations removed" className="mt-2 space-y-1.5">
              {d.installations.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <Plug aria-hidden="true" size={13} className="shrink-0 text-subtle" />
                  <span className="truncate text-text">{i.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {d && d.workflows.length > 0 && (
          <section>
            <p>
              {d.workflows.length === 1 ? "This workflow uses" : "These workflows use"} it. Their
              steps from {ext.name} will fail until you change them:
            </p>
            <ul aria-label="Workflows that use it" className="mt-2 space-y-1.5">
              {d.workflows.map((w) => (
                <li key={w.id} className="flex items-center gap-2">
                  <Workflow aria-hidden="true" size={13} className="shrink-0 text-subtle" />
                  <Link
                    to="/workflows/$id"
                    params={{ id: w.id }}
                    className="truncate text-text decoration-faint underline-offset-2 hover:underline"
                  >
                    {w.name}
                  </Link>
                  {w.enabled && (
                    <Badge tone="ok" className="h-5 px-1.5">
                      on
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
