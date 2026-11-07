import type {
  ConnectorView,
  DiscoverEntryView,
  ExtensionKind,
  ExtensionView,
  InstallationView,
} from "@sling/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpCircle,
  Check,
  Download,
  Info,
  Plus,
  Puzzle,
  Search,
  Shield,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ConnectorSetupDialog } from "../components/ConnectorSetup.tsx";
import { DetailsDialog } from "../components/extensions/DetailsDialog.tsx";
import {
  Adds,
  ExtensionIcon,
  kindIcon,
  PublisherLabel,
  StatusLabel,
} from "../components/extensions/ExtensionBits.tsx";
import { PreviewDialog } from "../components/extensions/PreviewDialog.tsx";
import { RemoveDialog } from "../components/extensions/RemoveDialog.tsx";
import { AddCatalogDialog, Sources } from "../components/extensions/Sources.tsx";
import { Page, Toolbar } from "../components/Page.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorText,
  Input,
  Skeleton,
  Switch,
  Tabs,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import {
  type PreviewSource,
  useDiscover,
  useExtensions,
  useSetEnabled,
} from "../lib/extensionApi.ts";
import {
  EXTENSION_STATUS,
  filterDiscover,
  hasHighRisk,
  KIND_LABEL,
  permissionSummary,
} from "../lib/extensions.ts";
import { plural } from "../lib/format.ts";
import { qk } from "../lib/workflowApi.ts";
import { type ExtensionsTab, extensionsRoute } from "../router.tsx";

type Kind = ExtensionKind | "all";
const KINDS: Kind[] = ["all", "connector", "provider", "workflows"];

export function ExtensionsPage() {
  const search = extensionsRoute.useSearch();
  const navigate = useNavigate();
  const tab: ExtensionsTab = search.tab ?? "installed";
  const setTab = (next: ExtensionsTab) =>
    void navigate({ to: "/extensions", search: next === "installed" ? {} : { tab: next } });

  const extensions = useExtensions();
  const list = useMemo(
    () => [...(extensions.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [extensions.data],
  );
  const updates = list.filter((x) => x.update).length;

  const [preview, setPreview] = useState<PreviewSource | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [addingCatalog, setAddingCatalog] = useState(false);
  const [setting, setSetting] = useState<ConnectorView | null>(null);
  const qc = useQueryClient();
  // A new connector goes straight to its setup, unless the workspace has one already.
  const setUp = async (x: ExtensionView) => {
    const first = x.contents.connectors[0];
    if (!first) return;
    const [installations, connectors] = await Promise.all([
      api.get<InstallationView[]>("/api/installations"),
      api.get<ConnectorView[]>("/api/connectors"),
    ]);
    qc.setQueryData(qk.connectors(), connectors);
    if (installations.some((i) => i.connectorId === first.id)) return;
    const connector = connectors.find((c) => c.id === first.id);
    if (connector) setSetting(connector);
  };
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  // Dialogs follow the live list, and close if the extension goes away.
  const detailsExt = list.find((x) => x.id === details);
  const removingExt = list.find((x) => x.id === removing);

  const file = useRef<HTMLInputElement>(null);
  const upload = (
    <>
      <input
        ref={file}
        type="file"
        accept=".slx"
        className="hidden"
        aria-label="Extension package file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setPreview({ kind: "upload", file: f });
          e.target.value = "";
        }}
      />
      <Button icon={Upload} onClick={() => file.current?.click()}>
        Upload
      </Button>
    </>
  );

  return (
    <Page
      title="Extensions"
      badge={
        updates > 0 ? (
          <Badge tone="accent" dot>
            {plural(updates, "update")}
          </Badge>
        ) : undefined
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "installed", label: "Installed", count: list.length },
            { id: "discover", label: "Discover" },
            { id: "sources", label: "Sources" },
          ]}
        />
      }
      toolbar={
        tab === "discover" ? (
          // Not a Toolbar: on phones the chips take a row of their own, under search and Upload.
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3">
            <span className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <Search
                aria-hidden="true"
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle"
              />
              <Input
                type="search"
                aria-label="Search extensions"
                placeholder="Search extensions"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-[30px] pl-8"
              />
            </span>
            {/* Padding keeps focus rings clear of the scroll clip. */}
            <fieldset className="order-last -m-1 flex w-[calc(100%+0.5rem)] min-w-0 gap-1 overflow-x-auto p-1 sm:order-none sm:w-auto sm:flex-1">
              <legend className="sr-only">Kind</legend>
              {KINDS.map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "All" : KIND_LABEL[k]}
                </Chip>
              ))}
            </fieldset>
            {upload}
          </div>
        ) : tab === "sources" ? (
          <Toolbar
            actions={
              <Button variant="primary" icon={Plus} onClick={() => setAddingCatalog(true)}>
                Add catalog
              </Button>
            }
          />
        ) : (
          <Toolbar actions={upload} />
        )
      }
    >
      {tab === "installed" && (
        <Installed
          list={extensions.data ? list : undefined}
          pending={extensions.isPending}
          error={extensions.error}
          onDiscover={() => setTab("discover")}
          onUpdate={(x) =>
            x.update &&
            setPreview({
              kind: "update",
              extensionId: x.id,
              version: x.update.version,
              name: x.name,
            })
          }
          onDetails={(x) => setDetails(x.id)}
          onRemove={(x) => setRemoving(x.id)}
        />
      )}
      {tab === "discover" && (
        <Discover
          query={query}
          kind={kind}
          installed={list}
          onClear={() => {
            setQuery("");
            setKind("all");
          }}
          onSources={() => setTab("sources")}
          onPreview={setPreview}
        />
      )}
      {tab === "sources" && <Sources installed={list} />}

      {preview && (
        <PreviewDialog
          source={preview}
          onClose={() => setPreview(null)}
          onInstalled={(x) => void setUp(x)}
        />
      )}
      {setting && (
        <ConnectorSetupDialog
          connector={setting}
          title={`Set up ${setting.name}`}
          onClose={() => setSetting(null)}
        />
      )}
      {detailsExt && <DetailsDialog ext={detailsExt} onClose={() => setDetails(null)} />}
      {removingExt && <RemoveDialog ext={removingExt} onClose={() => setRemoving(null)} />}
      {addingCatalog && <AddCatalogDialog onClose={() => setAddingCatalog(false)} />}
    </Page>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "pressable inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        active
          ? "bg-surface-3 text-text shadow-active"
          : "text-muted hover:bg-surface-3 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Installed */

function Installed({
  list,
  pending,
  error,
  onDiscover,
  onUpdate,
  onDetails,
  onRemove,
}: {
  list: ExtensionView[] | undefined;
  pending: boolean;
  error: unknown;
  onDiscover: () => void;
  onUpdate: (x: ExtensionView) => void;
  onDetails: (x: ExtensionView) => void;
  onRemove: (x: ExtensionView) => void;
}) {
  if (list?.length === 0) {
    return (
      <Empty
        fill
        icon={Puzzle}
        title="No extensions yet"
        action={
          <Button variant="primary" onClick={onDiscover}>
            Browse extensions
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3 px-5 pt-1 pb-6">
      {pending && (
        <>
          <Skeleton className="h-[172px] w-full rounded-xl" />
          <Skeleton className="h-[172px] w-full rounded-xl" />
        </>
      )}
      <ErrorText error={error} />
      {list?.map((x) => (
        <ExtensionCard
          key={x.id}
          ext={x}
          onUpdate={() => onUpdate(x)}
          onDetails={() => onDetails(x)}
          onRemove={() => onRemove(x)}
        />
      ))}
    </div>
  );
}

function ExtensionCard({
  ext,
  onUpdate,
  onDetails,
  onRemove,
}: {
  ext: ExtensionView;
  onUpdate: () => void;
  onDetails: () => void;
  onRemove: () => void;
}) {
  const toggle = useSetEnabled(ext.id);
  const status = EXTENSION_STATUS[ext.status];
  // A revoked version is turned off with the catalog's reason, which the notice already says.
  const detail =
    ext.statusDetail && ext.statusDetail !== ext.revoked?.reason
      ? ext.statusDetail
      : ext.status === "error"
        ? status.hint
        : null;

  return (
    <article aria-label={ext.name}>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 p-4">
          <ExtensionIcon ext={ext} fallback={kindIcon(ext.kinds)} />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium">{ext.name}</span>
              <span className="tabular shrink-0 text-xs text-subtle">{ext.version}</span>
            </p>
            <div className="mt-0.5 flex min-w-0 items-center">
              <PublisherLabel
                publisher={ext.publisher}
                included={ext.source === "included"}
                signed={ext.signed}
              />
            </div>
          </div>
          <StatusLabel ext={ext} />
          <Switch
            checked={ext.enabled}
            label={`${ext.enabled ? "Disable" : "Enable"} ${ext.name}`}
            disabled={toggle.isPending}
            onChange={(enabled) => toggle.mutate(enabled)}
          />
        </div>
        <div className="space-y-2 px-4 pb-3.5 sm:pl-16">
          {ext.description && (
            <p className="line-clamp-2 text-xs leading-4 text-muted">{ext.description}</p>
          )}
          <Adds contents={ext.contents} />
          {ext.revoked && (
            <p
              role="alert"
              className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] px-3 py-2 text-xs leading-4 text-[var(--tag-red-text)]"
            >
              Its catalog revoked version {ext.version}: {ext.revoked.reason}
            </p>
          )}
          {detail && (
            <p
              className={cx(
                "text-xs leading-4",
                ext.status === "error" ? "text-danger" : "text-muted",
              )}
            >
              {detail}
            </p>
          )}
          <ErrorText error={toggle.error} />
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" icon={Info} onClick={onDetails}>
            Details
          </Button>
          {ext.update && (
            <Button size="sm" variant="primary" icon={ArrowUpCircle} onClick={onUpdate}>
              Update to {ext.update.version}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost-danger"
            icon={Trash2}
            className="ml-auto"
            aria-label={`Remove ${ext.name}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </Card>
    </article>
  );
}

/* ----------------------------------------------------------------- Discover */

function Discover({
  query,
  kind,
  installed,
  onClear,
  onSources,
  onPreview,
}: {
  query: string;
  kind: Kind;
  installed: ExtensionView[];
  onClear: () => void;
  onSources: () => void;
  onPreview: (source: PreviewSource) => void;
}) {
  const discover = useDiscover();
  const entries = discover.data ?? [];
  const shown = filterDiscover(entries, query, kind);
  const byId = new Map(installed.map((x) => [x.id, x]));

  if (discover.data && entries.length === 0) {
    return (
      <Empty
        fill
        icon={Puzzle}
        title="Nothing to install"
        action={<Button onClick={onSources}>Add a catalog</Button>}
      >
        Your catalogs list no extensions.
      </Empty>
    );
  }
  if (discover.data && shown.length === 0) {
    return (
      <Empty
        fill
        icon={Search}
        title="No matches"
        action={<Button onClick={onClear}>Show all</Button>}
      >
        Nothing in your catalogs matches
        {query.trim() ? ` "${query.trim()}"` : ""}
        {kind !== "all" ? ` in ${KIND_LABEL[kind].toLowerCase()}` : ""}.
      </Empty>
    );
  }
  return (
    <div className="px-5 pt-1 pb-6">
      <ErrorText error={discover.error} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {discover.isPending &&
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[187px] w-full rounded-xl" />)}
        {shown.map((e) => (
          <DiscoverCard
            key={`${e.catalogId}/${e.id}`}
            entry={e}
            installed={byId.get(e.id)}
            onPreview={onPreview}
          />
        ))}
      </div>
    </div>
  );
}

function DiscoverCard({
  entry: e,
  installed,
  onPreview,
}: {
  entry: DiscoverEntryView;
  installed: ExtensionView | undefined;
  onPreview: (source: PreviewSource) => void;
}) {
  const included = e.catalogId === "included";
  const latest = e.latest;
  const high = latest ? hasHighRisk(latest.permissions) : false;
  const summary = permissionSummary(latest?.permissions ?? []);
  const PermIcon = high ? ShieldAlert : Shield;

  let action: ReactNode;
  if (!latest) {
    action = <Badge>unavailable</Badge>;
  } else if (e.installed?.updateAvailable) {
    action = (
      <Button
        size="sm"
        variant="primary"
        icon={ArrowUpCircle}
        aria-label={`Update ${e.name} to ${latest.version}`}
        onClick={() =>
          onPreview({ kind: "update", extensionId: e.id, version: latest.version, name: e.name })
        }
      >
        Update
      </Button>
    );
  } else if (e.installed) {
    action = (
      <span className="inline-flex h-[26px] items-center gap-1 text-xs text-muted">
        <Check aria-hidden="true" size={13} className="text-ok" />
        Installed
      </span>
    );
  } else {
    action = (
      <Button
        size="sm"
        icon={Download}
        aria-label={`Install ${e.name}`}
        onClick={() =>
          onPreview({
            kind: "catalog",
            catalogId: e.catalogId,
            extensionId: e.id,
            version: latest.version,
            name: e.name,
            description: e.description,
          })
        }
      >
        Install
      </Button>
    );
  }

  return (
    <article aria-label={e.name}>
      <Card className="flex h-full flex-col p-4 transition-shadow duration-150 hover:shadow-card-hover">
        <div className="flex items-center justify-between gap-3">
          <ExtensionIcon ext={installed} fallback={kindIcon(e.kinds)} />
          {action}
        </div>
        <h3 className="mt-3 flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{e.name}</span>
          {latest && (
            <span className="tabular shrink-0 text-xs font-normal text-subtle">
              {latest.version}
            </span>
          )}
        </h3>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-subtle">
          <PublisherLabel
            publisher={e.publisher}
            included={included}
            signed={e.publisher !== null}
          />
          {!included && <span className="truncate">· {e.catalogName}</span>}
        </div>
        <p className="mt-2 line-clamp-2 min-h-8 flex-1 text-xs leading-4 text-muted">
          {e.description}
        </p>
        <p
          className={cx(
            "mt-3 flex min-w-0 items-center gap-1.5 text-xs",
            high ? "text-warn" : "text-subtle",
          )}
          title={latest?.permissions.map((l) => l.text).join("\n") || undefined}
        >
          {latest ? (
            <>
              <PermIcon aria-hidden="true" size={12} className="shrink-0" />
              <span className="truncate">{summary.text}</span>
              {summary.more > 0 && <span className="shrink-0">+{summary.more} more</span>}
            </>
          ) : (
            <span className="truncate text-muted">{e.unavailable ?? "No version works here."}</span>
          )}
        </p>
      </Card>
    </article>
  );
}
