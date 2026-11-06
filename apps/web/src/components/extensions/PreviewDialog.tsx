import type { DiscoverEntryView, ExtensionPreview } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  applyExtension,
  extensionApi,
  isExtensionView,
  isStalePreview,
  type PreviewSource,
  useDiscover,
} from "../../lib/extensionApi.ts";
import { formatBytes, runsCode } from "../../lib/extensions.ts";
import { qk } from "../../lib/workflowApi.ts";
import { Button, Dialog, ErrorText, Mono, Skeleton, Spinner } from "../ui.tsx";
import {
  Adds,
  AssistantNodes,
  ExtensionIcon,
  kindIcon,
  PermissionList,
  PublisherLabel,
  SectionHeading,
} from "./ExtensionBits.tsx";

/**
 * Install or update, in two steps: the server stages and checks the package
 * and answers with a preview, then the user confirms what they saw. A missing
 * requirement can be installed from here, after which the original package
 * is previewed again.
 */
export function PreviewDialog({ source, onClose }: { source: PreviewSource; onClose: () => void }) {
  const qc = useQueryClient();
  const [stack, setStack] = useState<PreviewSource[]>([source]);
  const top = stack[stack.length - 1] ?? source;
  const nested = stack.length > 1;
  const update = top.kind === "update";

  const run = useMutation({ mutationFn: (s: PreviewSource) => extensionApi.preview(s) });
  const preview = run.data;
  const needsTrust = Boolean(preview?.signed && preview.publisher && !preview.publisher.trusted);

  // Back to the package that needed this one. A copy, so it's previewed again.
  const pop = () =>
    setStack((s) => {
      const parent = s[s.length - 2];
      return parent ? [...s.slice(0, -2), { ...parent }] : s;
    });

  const confirm = useMutation({
    mutationFn: (p: ExtensionPreview) => extensionApi.install(p, needsTrust),
    onSuccess: (ext) => {
      if (isExtensionView(ext)) applyExtension(qc, ext, { changed: true });
      else void qc.invalidateQueries({ queryKey: qk.extensions() });
      if (needsTrust) void qc.invalidateQueries({ queryKey: qk.publishers() });
      if (nested) pop();
      else onClose();
    },
  });

  const { mutate: startPreview } = run;
  const { reset: resetConfirm } = confirm;
  const started = useRef<PreviewSource | null>(null);
  useEffect(() => {
    if (started.current === top) return;
    started.current = top;
    resetConfirm();
    startPreview(top);
  }, [top, startPreview, resetConfirm]);

  // Staged packages expire. Past that, confirming can only fail.
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const ms = Date.parse(preview.expiresAt) - Date.now();
    // A clock that disagrees with the server's would expire it at once; let the server say.
    if (!(ms > 0)) return;
    const timer = window.setTimeout(() => setExpired(preview.stagingId), Math.min(ms, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [preview]);
  const stale =
    preview !== undefined && (expired === preview.stagingId || isStalePreview(confirm.error));

  const name = preview?.name ?? (top.kind === "upload" ? top.file.name : top.name);
  const verb = update ? "update" : "install";
  const confirmLabel = needsTrust ? `Trust and ${verb}` : update ? "Update" : "Install";
  const again = () => {
    resetConfirm();
    startPreview(top);
  };

  return (
    <Dialog
      title={`${update ? "Update" : "Install"} ${name}`}
      description={
        update
          ? undefined
          : (preview?.description ?? (top.kind === "catalog" ? top.description : undefined))
      }
      onClose={onClose}
      footer={
        <>
          {nested && (
            <Button icon={ArrowLeft} className="mr-auto" onClick={pop}>
              Back
            </Button>
          )}
          {!preview && !run.error && (
            <p className="mr-auto flex items-center gap-2 text-xs text-muted">
              <Spinner className="size-3.5" /> Checking the package
            </p>
          )}
          {stale && <p className="mr-auto text-xs text-warn">This preview expired.</p>}
          {!stale && <ErrorText error={confirm.error} />}
          <Button onClick={onClose}>Cancel</Button>
          {stale || run.error ? (
            <Button variant="primary" icon={RefreshCw} busy={run.isPending} onClick={again}>
              {stale ? "Preview again" : "Try again"}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={needsTrust ? KeyRound : undefined}
              busy={confirm.isPending}
              disabled={!preview || preview.problems.length > 0}
              onClick={() => preview && confirm.mutate(preview)}
            >
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      {!preview && !run.error && <PreviewSkeleton />}
      {run.error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] p-3 text-[13px] text-[var(--tag-red-text)]"
        >
          <p className="font-medium">Sling couldn't check this package.</p>
          <p className="mt-1">{run.error.message}</p>
        </div>
      )}
      {preview && (
        <PreviewBody
          preview={preview}
          needsTrust={needsTrust}
          onInstall={(next) => setStack((s) => [...s, next])}
        />
      )}
    </Dialog>
  );
}

function PreviewSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Checking the package" className="space-y-5">
      <Skeleton className="h-[62px] w-full rounded-xl" />
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

function PreviewBody({
  preview: p,
  needsTrust,
  onInstall,
}: {
  preview: ExtensionPreview;
  needsTrust: boolean;
  onInstall: (source: PreviewSource) => void;
}) {
  const update = p.diff !== null;
  const missingCount = p.missing.extensions.length + p.missing.connectors.length;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3 shadow-raised">
        <ExtensionIcon fallback={kindIcon(p.kinds)} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-medium">{p.name}</span>
            <span className="tabular text-xs text-muted">
              {update && p.diff ? (
                <>
                  {p.diff.fromVersion}
                  <ArrowRight aria-label="to" size={11} className="mx-1 inline align-[-1px]" />
                  {p.version}
                </>
              ) : (
                p.version
              )}
              {" · "}
              {formatBytes(p.size)}
            </span>
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PublisherLabel
              publisher={p.publisher}
              included={p.source === "included"}
              signed={p.signed}
            />
            {p.publisher?.trusted && <Mono className="text-[11px]">{p.publisher.fingerprint}</Mono>}
          </div>
        </div>
      </div>

      {p.problems.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] p-3 text-[13px] text-[var(--tag-red-text)]"
        >
          <p className="font-medium">
            {update ? "This update can't be installed" : "This can't be installed"}
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {p.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {!p.signed && p.source !== "included" && (
        <p className="text-xs leading-4 text-muted">
          Nobody signed this package, so Sling can't tell who made it. Install it only if you built
          it or trust where it came from.
        </p>
      )}

      {update && p.diff ? (
        <section>
          <SectionHeading>Permission changes</SectionHeading>
          {p.diff.added.length === 0 && p.diff.removed.length === 0 ? (
            <p className="text-[13px] text-muted">None. It keeps the permissions it has.</p>
          ) : (
            <div className="space-y-3">
              {p.diff.added.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-subtle">Added</p>
                  <PermissionList lines={p.diff.added} mark="added" label="Permissions added" />
                </div>
              )}
              {p.diff.removed.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-subtle">Removed</p>
                  <PermissionList
                    lines={p.diff.removed}
                    mark="removed"
                    label="Permissions removed"
                  />
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <>
          <section>
            <SectionHeading>Adds</SectionHeading>
            <Adds contents={p.contents} />
            {!runsCode(p.contents) && (
              <p className="mt-3 text-xs leading-4 text-muted">
                Templates only. It runs no code and needs no permissions.
              </p>
            )}
          </section>
          {runsCode(p.contents) && (
            <section>
              <SectionHeading>Permissions</SectionHeading>
              {p.permissions.length > 0 ? (
                <PermissionList lines={p.permissions} />
              ) : (
                <p className="text-[13px] text-muted">None.</p>
              )}
              <p className="mt-3 text-xs leading-4 text-muted">
                It runs in its own process, with no access to files, other credentials, or your
                machines.
              </p>
            </section>
          )}
        </>
      )}

      <AssistantNodes nodes={p.contents.nodes} />

      {missingCount > 0 && <Missing preview={p} onInstall={onInstall} />}

      {needsTrust && p.publisher && (
        <section className="rounded-xl bg-surface-2 p-3 shadow-raised">
          <p className="text-[13px] font-medium">Trust {p.publisher.name}?</p>
          <p className="mt-1 text-xs leading-4 text-muted">
            You haven't installed anything signed with this key before. Check the fingerprint with
            the publisher. Trusting it lets you install and update their packages.
          </p>
          <p className="mt-2.5 flex items-center gap-2">
            <KeyRound aria-hidden="true" size={14} className="text-subtle" />
            <span className="sr-only">Fingerprint</span>
            <span className="font-mono text-[13px] tracking-wide text-text">
              {p.publisher.fingerprint}
            </span>
          </p>
        </section>
      )}
    </div>
  );
}

/** Requirements that aren't installed, each with Install when a catalog has it. */
function Missing({
  preview: p,
  onInstall,
}: {
  preview: ExtensionPreview;
  onInstall: (source: PreviewSource) => void;
}) {
  const fromCatalog = p.missing.extensions.some((m) => m.catalogId !== null);
  const discover = useDiscover(fromCatalog);
  const entry = (id: string, catalogId: string | null): DiscoverEntryView | undefined =>
    discover.data?.find((e) => e.id === id && e.catalogId === catalogId);
  return (
    <section>
      <SectionHeading>Needs first</SectionHeading>
      <ul aria-label="Missing requirements" className="space-y-2">
        {p.missing.extensions.map((m) => {
          const e = entry(m.id, m.catalogId);
          const latest = e?.latest;
          return (
            <li key={m.id} className="flex min-h-[26px] items-center gap-3 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="text-soft">{e?.name ?? m.id}</span>{" "}
                <span className="tabular text-xs text-subtle">{m.range}</span>
              </span>
              {m.catalogId === null ? (
                <span className="text-xs text-muted">Not in your catalogs</span>
              ) : latest && e ? (
                <Button
                  size="sm"
                  aria-label={`Install ${e.name}`}
                  onClick={() =>
                    onInstall({
                      kind: "catalog",
                      catalogId: e.catalogId,
                      extensionId: e.id,
                      version: latest.version,
                      name: e.name,
                    })
                  }
                >
                  Install
                </Button>
              ) : discover.isPending ? (
                <Button size="sm" busy>
                  Install
                </Button>
              ) : (
                <span className="text-xs text-muted">{e?.unavailable ?? "Unavailable"}</span>
              )}
            </li>
          );
        })}
        {p.missing.connectors.map((c) => (
          <li key={`connector:${c}`} className="flex min-h-[26px] items-center gap-3 text-[13px]">
            <span className="min-w-0 flex-1 text-soft">The {c} connector</span>
            <span className="text-xs text-muted">Not on this server</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
