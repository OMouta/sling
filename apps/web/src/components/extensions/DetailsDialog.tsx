import type { ExtensionDetailView, ExtensionView } from "@sling/core";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { useCatalogs, useExtension, useSetEnabled } from "../../lib/extensionApi.ts";
import { runsCode } from "../../lib/extensions.ts";
import { ago } from "../../lib/format.ts";
import { ChatMarkdown } from "../ChatMarkdown.tsx";
import { Badge, cx, Dialog, ErrorText, Skeleton, Switch } from "../ui.tsx";
import {
  Adds,
  ExtensionIcon,
  kindIcon,
  PermissionList,
  PublisherLabel,
  SectionHeading,
  StatusLabel,
} from "./ExtensionBits.tsx";

/** Everything about one installed extension: its README, permissions, versions, and log. */
export function DetailsDialog({ ext, onClose }: { ext: ExtensionView; onClose: () => void }) {
  const detail = useExtension(ext.id);
  const d = detail.data;
  const toggle = useSetEnabled(ext.id);
  const catalogs = useCatalogs(ext.source === "catalog");
  const catalog = catalogs.data?.find((c) => c.id === ext.catalogId);
  const hasCode = runsCode(ext.contents);

  return (
    <Dialog wide title={ext.name} description={ext.description} onClose={onClose}>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-6">
          <ErrorText error={detail.error} />
          <section aria-label="Readme">
            {!d && !detail.error ? (
              <div className="space-y-2.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : d?.readme ? (
              <div className="prose-chat text-[13px] leading-6 text-soft">
                <ChatMarkdown skipHtml>{readmeBody(d.readme, d.name)}</ChatMarkdown>
              </div>
            ) : (
              d && <p className="text-[13px] text-muted">It has no README.</p>
            )}
          </section>
          {hasCode && (
            <section>
              <SectionHeading>Log</SectionHeading>
              <Log detail={d} />
            </section>
          )}
        </div>

        <aside className="space-y-5 max-md:order-first md:self-start">
          <div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3 shadow-raised">
            <ExtensionIcon ext={ext} fallback={kindIcon(ext.kinds)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{ext.enabled ? "On" : "Off"}</p>
              <StatusLabel ext={ext} />
            </div>
            <Switch
              checked={ext.enabled}
              label={`${ext.enabled ? "Disable" : "Enable"} ${ext.name}`}
              disabled={toggle.isPending}
              onChange={(enabled) => toggle.mutate(enabled)}
            />
          </div>
          <ErrorText error={toggle.error} />
          {ext.statusDetail && (
            <p
              className={cx(
                "text-xs leading-4",
                ext.status === "error" ? "text-danger" : "text-muted",
              )}
            >
              {ext.statusDetail}
            </p>
          )}

          <dl className="space-y-3">
            <Item label="Version">
              <span className="tabular">{ext.version}</span>
            </Item>
            <Item label="Publisher">
              <span className="flex flex-col gap-1">
                <PublisherLabel
                  publisher={ext.publisher}
                  included={ext.source === "included"}
                  signed={ext.signed}
                />
                {ext.publisher && (
                  <span className="font-mono text-[11.5px] text-subtle">
                    {ext.publisher.fingerprint}
                  </span>
                )}
              </span>
            </Item>
            <Item label="Source">
              {ext.source === "included"
                ? "Ships with Sling"
                : ext.source === "upload"
                  ? "Uploaded file"
                  : (catalog?.name ?? "A catalog")}
            </Item>
            <Item label="Installed">
              <span title={new Date(ext.installedAt).toLocaleString()}>{ago(ext.installedAt)}</span>
            </Item>
            <Item label="Digest">
              {d ? (
                <span className="block font-mono text-[11px] leading-4 break-all text-soft">
                  {d.digest}
                </span>
              ) : (
                <Skeleton className="h-8 w-full" />
              )}
            </Item>
            {ext.homepage && (
              <Item label="Homepage">
                <a
                  href={ext.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-accent-text hover:underline"
                >
                  <span className="truncate">{hostOf(ext.homepage)}</span>
                  <ExternalLink aria-hidden="true" size={12} className="shrink-0" />
                </a>
              </Item>
            )}
          </dl>

          <section>
            <SectionHeading>Adds</SectionHeading>
            <Adds contents={ext.contents} className="flex-col" />
          </section>

          <section>
            <SectionHeading>Permissions</SectionHeading>
            {ext.permissions.length > 0 ? (
              <PermissionList lines={ext.permissions} />
            ) : (
              <p className="text-[13px] text-muted">None.</p>
            )}
          </section>

          {ext.source !== "upload" && (
            <section>
              <SectionHeading>Versions</SectionHeading>
              <Versions ext={ext} detail={d} />
            </section>
          )}
        </aside>
      </div>
    </Dialog>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-[13px] text-soft">{children}</dd>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Versions({ ext, detail }: { ext: ExtensionView; detail?: ExtensionDetailView }) {
  if (!detail) return <Skeleton className="h-12 w-full" />;
  if (detail.versions.length === 0) {
    return <p className="text-[13px] text-muted">No catalog lists it any more.</p>;
  }
  return (
    <ul aria-label="Versions" className="max-h-48 space-y-2 overflow-y-auto">
      {detail.versions.map((v) => (
        <li key={v.version} className="text-[13px]">
          <span className="flex items-center gap-2">
            <span className={cx("tabular", v.revoked ? "text-muted line-through" : "text-soft")}>
              {v.version}
            </span>
            {v.version === ext.version && <Badge className="h-5 px-1.5">installed</Badge>}
            {v.revoked && (
              <Badge tone="danger" className="h-5 px-1.5">
                revoked
              </Badge>
            )}
            {v.publishedAt && (
              <span className="ml-auto text-xs text-subtle">{ago(v.publishedAt)}</span>
            )}
          </span>
          {v.revoked && <span className="mt-0.5 block text-xs text-muted">{v.revoked.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

const LEVEL_CLASS = { info: "text-subtle", warn: "text-warn", error: "text-danger" } as const;

function Log({ detail }: { detail?: ExtensionDetailView }) {
  if (!detail) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (detail.log.length === 0) {
    return (
      <p className="rounded-lg bg-field px-3 py-2.5 text-xs text-muted shadow-field">
        Nothing logged since the server started.
      </p>
    );
  }
  return (
    <ol
      aria-label="Log"
      className="max-h-72 overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-[11.5px] leading-5 shadow-field"
    >
      {detail.log.map((line, i) => (
        // Log lines have no identity; their order never changes.
        // biome-ignore lint/suspicious/noArrayIndexKey: as above.
        <li key={i} className="flex gap-2.5 whitespace-pre-wrap">
          <time dateTime={line.at} className="shrink-0 text-faint">
            {new Date(line.at).toLocaleTimeString(undefined, { hour12: false })}
          </time>
          <span
            className={cx(
              "min-w-0 break-words",
              line.level === "info" ? "text-soft" : LEVEL_CLASS[line.level],
            )}
          >
            {line.message}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The README without a first heading that only repeats the name, which the dialog's title shows already. */
export function readmeBody(readme: string, name: string): string {
  const m = /^\s*#\s+(.+?)\s*\n/.exec(readme);
  return m && m[1]?.trim().toLowerCase() === name.trim().toLowerCase()
    ? readme.slice(m[0].length)
    : readme;
}
