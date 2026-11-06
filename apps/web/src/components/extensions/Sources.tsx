import type { CatalogView, ExtensionView, PublisherView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, KeyRound, Library, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { extensionApi, isCatalogView, useCatalogs, usePublishers } from "../../lib/extensionApi.ts";
import { ago, plural } from "../../lib/format.ts";
import { qk } from "../../lib/workflowApi.ts";
import {
  Button,
  Card,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Section,
  Skeleton,
  useConfirm,
} from "../ui.tsx";

/** Where extensions come from, and whose signatures Sling accepts. */
export function Sources({ installed }: { installed: ExtensionView[] }) {
  return (
    <div className="space-y-9 px-5 pt-1 pb-6">
      <Catalogs />
      <Publishers installed={installed} />
    </div>
  );
}

function Tile({ icon: Icon }: { icon: typeof Library }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
      <Icon aria-hidden="true" size={16} />
    </span>
  );
}

/* ----------------------------------------------------------------- Catalogs */

function Catalogs() {
  const catalogs = useCatalogs();
  const sorted = [...(catalogs.data ?? [])].sort(
    (a, b) => Number(b.included) - Number(a.included) || a.name.localeCompare(b.name),
  );
  return (
    <Section title="Catalogs" description="Sling checks each one every 6 hours for new versions.">
      {catalogs.isPending && <Skeleton className="h-[146px] w-full rounded-xl" />}
      <ErrorText error={catalogs.error} />
      {catalogs.data && (
        <Card>
          <ul aria-label="Catalogs" className="divide-y divide-border">
            {sorted.map((c) => (
              <CatalogRow key={c.id} catalog={c} />
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}

function CatalogRow({ catalog: c }: { catalog: CatalogView }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const replace = (next: CatalogView) =>
    qc.setQueryData<CatalogView[]>(qk.catalogs(), (list) =>
      list?.map((x) => (x.id === next.id ? next : x)),
    );
  const refresh = useMutation({
    mutationFn: () => extensionApi.refreshCatalog(c.id),
    onSuccess: (res) => {
      if (isCatalogView(res)) replace(res);
      else void qc.invalidateQueries({ queryKey: qk.catalogs() });
      // New versions show as updates, and new entries in Discover.
      void qc.invalidateQueries({ queryKey: qk.discover() });
      void qc.invalidateQueries({ queryKey: qk.extensions() });
    },
  });
  const remove = useMutation({
    mutationFn: () => extensionApi.removeCatalog(c.id),
    onSuccess: () => {
      qc.setQueryData<CatalogView[]>(qk.catalogs(), (list) => list?.filter((x) => x.id !== c.id));
      void qc.invalidateQueries({ queryKey: qk.discover() });
      void qc.invalidateQueries({ queryKey: qk.extensions() });
    },
  });
  const failure = refresh.error ?? remove.error;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Tile icon={c.included ? BadgeCheck : Library} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{c.name}</p>
        {c.included ? (
          <p className="truncate text-xs text-subtle">
            Ships with this server, so it can't be removed
          </p>
        ) : (
          <p className="truncate font-mono text-[11.5px] text-subtle" title={c.url ?? undefined}>
            {c.url}
          </p>
        )}
        {failure ? (
          <ErrorText error={failure} />
        ) : c.error ? (
          <p className="truncate text-xs text-danger" title={c.error}>
            Couldn't fetch it: {c.error}
          </p>
        ) : (
          <p className="truncate text-xs text-muted">
            {plural(c.extensionCount, "extension")}
            {!c.included && (
              <span title={c.fetchedAt ? new Date(c.fetchedAt).toLocaleString() : undefined}>
                {" · "}
                {c.fetchedAt ? `fetched ${ago(c.fetchedAt)}` : "not fetched yet"}
              </span>
            )}
          </p>
        )}
      </div>
      {!c.included && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            iconOnly
            variant="ghost"
            icon={RefreshCw}
            busy={refresh.isPending}
            aria-label={`Refresh ${c.name}`}
            title="Refresh"
            onClick={() => refresh.mutate()}
          />
          <Button
            size="sm"
            iconOnly
            variant="ghost-danger"
            icon={Trash2}
            busy={remove.isPending}
            aria-label={`Remove ${c.name}`}
            title="Remove"
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${c.name}?`,
                body: "Extensions you installed from it stay installed, but Sling stops checking it for updates.",
                action: "Remove",
                danger: true,
              });
              if (ok) remove.mutate();
            }}
          />
        </span>
      )}
      {dialog}
    </li>
  );
}

export function AddCatalogDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const add = useMutation({
    mutationFn: () => extensionApi.addCatalog(url.trim()),
    onSuccess: (res) => {
      if (isCatalogView(res)) {
        qc.setQueryData<CatalogView[]>(qk.catalogs(), (list) =>
          list ? [...list.filter((x) => x.id !== res.id), res] : list,
        );
      }
      void qc.invalidateQueries({ queryKey: qk.catalogs() }, { cancelRefetch: false });
      void qc.invalidateQueries({ queryKey: qk.discover() });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };
  return (
    <Dialog
      title="Add a catalog"
      description="A catalog is a JSON file that lists extensions and where to download them."
      onClose={onClose}
      footer={
        <>
          <ErrorText error={add.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="add-catalog"
            busy={add.isPending}
            disabled={!url.trim()}
          >
            Add
          </Button>
        </>
      }
    >
      <form id="add-catalog" onSubmit={submit}>
        <Field label="URL" hint="Served over HTTPS. Sling fetches it now to check it.">
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/extensions/catalog.json"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/* --------------------------------------------------------------- Publishers */

function Publishers({ installed }: { installed: ExtensionView[] }) {
  const publishers = usePublishers();
  const names = new Map(installed.map((x) => [x.id, x.name]));
  return (
    <Section
      title="Trusted publishers"
      description="Keys you trusted when you installed something they signed."
    >
      {publishers.isPending && <Skeleton className="h-[74px] w-full rounded-xl" />}
      <ErrorText error={publishers.error} />
      {publishers.data && (
        <Card>
          {publishers.data.length === 0 ? (
            <Empty icon={KeyRound} title="No trusted publishers" className="py-10">
              Installing a signed extension asks you to trust its publisher's key.
            </Empty>
          ) : (
            <ul aria-label="Trusted publishers" className="divide-y divide-border">
              {publishers.data.map((p) => (
                <PublisherRow
                  key={p.keyId}
                  publisher={p}
                  pinned={p.extensions.map((id) => names.get(id) ?? id)}
                />
              ))}
            </ul>
          )}
        </Card>
      )}
    </Section>
  );
}

function PublisherRow({ publisher: p, pinned }: { publisher: PublisherView; pinned: string[] }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const remove = useMutation({
    mutationFn: () => extensionApi.removePublisher(p.keyId),
    onSuccess: () => {
      qc.setQueryData<PublisherView[]>(qk.publishers(), (list) =>
        list?.filter((x) => x.keyId !== p.keyId),
      );
      void qc.invalidateQueries({ queryKey: qk.discover() });
      void qc.invalidateQueries({ queryKey: qk.extensions() });
    },
  });
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Tile icon={KeyRound} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{p.name}</p>
        <p className="truncate font-mono text-[11.5px] text-subtle">{p.fingerprint}</p>
        {remove.error ? (
          <ErrorText error={remove.error} />
        ) : (
          <p className="truncate text-xs text-muted">
            {pinned.length > 0 ? `Signs ${pinned.join(", ")}` : "Nothing installed uses it"}
            <span title={new Date(p.trustedAt).toLocaleString()}>
              {" · "}trusted {ago(p.trustedAt)}
            </span>
          </p>
        )}
      </div>
      <Button
        size="sm"
        iconOnly
        variant="ghost-danger"
        icon={Trash2}
        busy={remove.isPending}
        aria-label={`Stop trusting ${p.name}`}
        title="Stop trusting"
        onClick={async () => {
          const ok = await confirm({
            title: `Stop trusting ${p.name}?`,
            body: (
              <>
                New installs and updates signed by this key will be refused.
                {pinned.length > 0 &&
                  ` ${pinned.join(", ")} ${pinned.length === 1 ? "stays" : "stay"} installed and keep${pinned.length === 1 ? "s" : ""} running.`}
              </>
            ),
            action: "Stop trusting",
            danger: true,
          });
          if (ok) remove.mutate();
        }}
      />
      {dialog}
    </li>
  );
}
