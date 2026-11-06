import type { WorkflowDefinition, WorkflowVersionView } from "@sling/workflow";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Download, FileJson, Package } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import type { CatalogIndex } from "../../lib/workflow/catalog.ts";
import { downloadJson, exportFileName, useVersion, useVersions } from "../../lib/workflowApi.ts";
import { Badge, Button, cx, Dialog, Empty, ErrorText, Menu, MenuItem, Spinner } from "../ui.tsx";
import { ExportPackageDialog } from "./ExportPackageDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { ReadOnlyCanvas, useReadOnlyStore } from "./ReadOnlyCanvas.tsx";

export function VersionsTab({
  workflowId,
  workflowName,
  activeVersion,
  catalog,
  viewing,
  onView,
  onRestore,
}: {
  workflowId: string;
  workflowName: string;
  activeVersion: number | null;
  catalog: CatalogIndex;
  viewing: number | null;
  onView: (n: number | null) => void;
  onRestore: (def: WorkflowDefinition) => Promise<void>;
}) {
  const versions = useVersions(workflowId);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [packaging, setPackaging] = useState(false);
  const exportJson = useMutation({
    mutationFn: async () => {
      const def = await api.get<WorkflowDefinition>(`/api/workflows/${workflowId}/export`);
      downloadJson(exportFileName(def?.name || workflowName), def);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div
        className={cx(
          "space-y-3 overflow-y-auto p-4 md:w-96 md:shrink-0 md:border-r md:border-border",
          viewing !== null && "hidden md:block",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="section-label">Versions</h2>
          <Menu
            label="Export"
            trigger={({ open, toggle }) => (
              <Button
                size="sm"
                icon={Download}
                busy={exportJson.isPending}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                Export
                <ChevronDown aria-hidden="true" size={12} className="-mr-0.5 text-subtle" />
              </Button>
            )}
          >
            <MenuItem icon={FileJson} onSelect={() => exportJson.mutate()}>
              Export JSON
            </MenuItem>
            <MenuItem icon={Package} onSelect={() => setPackaging(true)}>
              Export as package
            </MenuItem>
          </Menu>
        </div>
        {packaging && (
          <ExportPackageDialog
            workflowId={workflowId}
            workflowName={workflowName}
            activeVersion={activeVersion}
            onClose={() => setPackaging(false)}
          />
        )}
        <ErrorText error={exportJson.error} />
        {versions.isPending && <Spinner />}
        <ErrorText error={versions.error} />
        {versions.data?.length === 0 && (
          <Empty title="Not published yet">Publish the draft to create version 1.</Empty>
        )}
        <ul className="space-y-2">
          {[...(versions.data ?? [])]
            .sort((a, b) => b.number - a.number)
            .map((v) => (
              <li
                key={v.number}
                className={cx(
                  "rounded-xl bg-surface p-3 transition-shadow duration-150",
                  viewing === v.number ? "shadow-[0_0_0_1px_var(--accent-text)]" : "shadow-card",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">Version {v.number}</span>
                  {v.number === activeVersion && <Badge tone="ok">active</Badge>}
                  <span
                    className="ml-auto text-xs text-muted"
                    title={new Date(v.createdAt).toLocaleString()}
                  >
                    {ago(v.createdAt)}
                  </span>
                </div>
                {v.note && <p className="mt-1 text-xs text-muted">{v.note}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onView(viewing === v.number ? null : v.number)}>
                    {viewing === v.number ? "Close" : "View"}
                  </Button>
                  <Button size="sm" onClick={() => setConfirm(v.number)}>
                    Restore as draft
                  </Button>
                </div>
              </li>
            ))}
        </ul>
      </div>
      <div className="min-h-0 flex-1">
        {viewing !== null ? (
          <VersionView
            workflowId={workflowId}
            n={viewing}
            catalog={catalog}
            onClose={() => onView(null)}
          />
        ) : (
          <div className="hidden h-full place-items-center p-6 text-xs text-muted md:grid">
            Pick a version to view it.
          </div>
        )}
      </div>
      {confirm !== null && (
        <RestoreDialog
          workflowId={workflowId}
          n={confirm}
          onClose={() => setConfirm(null)}
          onRestore={onRestore}
        />
      )}
    </div>
  );
}

function VersionView({
  workflowId,
  n,
  catalog,
  onClose,
}: {
  workflowId: string;
  n: number;
  catalog: CatalogIndex;
  onClose: () => void;
}) {
  const version = useVersion(workflowId, n);
  const store = useReadOnlyStore(version.data?.definition, catalog);
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-sidebar px-4 py-2">
        <span className="font-medium">Version {n}</span>
        <span className="text-xs text-subtle">read-only</span>
        <div className="ml-auto flex gap-2">
          {version.data && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                downloadJson(
                  exportFileName(`${version.data.definition.name} v${n}`),
                  (version.data as WorkflowVersionView).definition,
                )
              }
            >
              Download
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {version.isPending && (
          <div className="grid h-full place-items-center">
            <Spinner />
          </div>
        )}
        <ErrorText error={version.error} />
        {store && (
          <ReadOnlyCanvas
            store={store}
            side={
              <Inspector
                readOnly
                empty={<p className="p-4 text-xs text-muted">Select a node to see its settings.</p>}
              />
            }
          />
        )}
      </div>
    </div>
  );
}

function RestoreDialog({
  workflowId,
  n,
  onClose,
  onRestore,
}: {
  workflowId: string;
  n: number;
  onClose: () => void;
  onRestore: (def: WorkflowDefinition) => Promise<void>;
}) {
  const version = useVersion(workflowId, n);
  const restore = useMutation({
    mutationFn: async () => {
      if (!version.data) return;
      await onRestore(version.data.definition);
      onClose();
    },
  });
  return (
    <Dialog
      title={`Restore version ${n}?`}
      onClose={onClose}
      footer={
        <>
          <ErrorText error={restore.error ?? version.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-autofocus
            busy={restore.isPending || version.isPending}
            onClick={() => restore.mutate()}
          >
            Restore
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-5 text-soft">
        The draft is replaced with version {n}. Publish afterwards to make it the active version.
        The current draft isn't kept, so export it first if you want it.
      </p>
    </Dialog>
  );
}
