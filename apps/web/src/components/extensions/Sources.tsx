import type { CatalogPreviewView, CatalogView, ExtensionView, PublisherView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, KeyRound, Library, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { extensionApi, isCatalogView, useCatalogs, usePublishers } from "../../lib/extensionApi.ts";
import { ago, plural } from "../../lib/format.ts";
import { qk } from "../../lib/workflowApi.ts";
import { Button, Card, Empty, ErrorText, Input, Section, Skeleton, useConfirm } from "../ui.tsx";
import { Wizard, type WizardStep } from "../Wizard.tsx";
import { StepNote } from "../WizardBits.tsx";

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
    <Section title="Catalogs">
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
          <p className="truncate text-xs text-subtle">Built in</p>
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

/**
 * Adds a catalog in two steps: its URL, then what's in it, fetched before
 * anything is stored, so you add it knowing what it lists.
 */
export function AddCatalogDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<CatalogPreviewView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => extensionApi.addCatalog(found?.url ?? url.trim()),
    onSuccess: (res) => {
      if (isCatalogView(res)) {
        qc.setQueryData<CatalogView[]>(qk.catalogs(), (list) =>
          list ? [...list.filter((x) => x.id !== res.id), res] : list,
        );
      }
      void qc.invalidateQueries({ queryKey: qk.catalogs() }, { cancelRefetch: false });
      void qc.invalidateQueries({ queryKey: qk.discover() });
    },
  });
  const more = found ? found.extensionCount - found.extensions.length : 0;

  const steps: WizardStep[] = [
    {
      id: "url",
      title: "Where's the catalog?",
      blocked: !url.trim(),
      onNext: async () => {
        setProblem(null);
        try {
          const res = await extensionApi.previewCatalog(url.trim());
          if (!res) return false;
          setFound(res);
          return true;
        } catch (err) {
          setProblem(err instanceof Error ? err.message : String(err));
          return false;
        }
      },
      content: (
        <>
          <Input
            type="url"
            inputMode="url"
            aria-label="Catalog URL"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/extensions/catalog.json"
            value={url}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              setProblem(null);
            }}
          />
          {problem ? (
            <StepNote tone="error">{problem}</StepNote>
          ) : (
            <StepNote>The catalog's JSON file, served over HTTPS.</StepNote>
          )}
        </>
      ),
    },
    {
      id: "review",
      title: found ? `Add ${found.name}?` : "Add it?",
      content: found && (
        <>
          <p className="truncate font-mono text-[11.5px] text-subtle" title={found.url}>
            {found.url}
          </p>
          <StepNote tone={found.extensionCount > 0 ? "ok" : "warn"}>
            Lists {plural(found.extensionCount, "extension")}
            {found.publishers.length > 0 && `, signed by ${found.publishers.join(", ")}`}
          </StepNote>
          {found.extensions.length > 0 && (
            <ul
              aria-label="Extensions in it"
              className="divide-y divide-border overflow-hidden rounded-xl bg-surface-2 shadow-raised"
            >
              {found.extensions.map((x) => (
                <li key={x.id} className="px-3.5 py-2.5">
                  <p className="truncate text-[13px] font-medium">{x.name}</p>
                  {x.description && (
                    <p className="line-clamp-2 text-xs leading-4 text-muted">{x.description}</p>
                  )}
                </li>
              ))}
              {more > 0 && <li className="px-3.5 py-2.5 text-xs text-subtle">and {more} more</li>}
            </ul>
          )}
        </>
      ),
    },
  ];

  return (
    <Wizard
      title="Add a catalog"
      steps={steps}
      finishLabel="Add"
      finishing={add.isPending}
      error={add.error instanceof Error ? add.error.message : null}
      onFinish={async () => {
        try {
          await add.mutateAsync();
          return true;
        } catch {
          return false;
        }
      }}
      onClose={onClose}
    />
  );
}

/* --------------------------------------------------------------- Publishers */

function Publishers({ installed }: { installed: ExtensionView[] }) {
  const publishers = usePublishers();
  const names = new Map(installed.map((x) => [x.id, x.name]));
  return (
    <Section title="Trusted publishers">
      {publishers.isPending && <Skeleton className="h-[74px] w-full rounded-xl" />}
      <ErrorText error={publishers.error} />
      {publishers.data && (
        <Card>
          {publishers.data.length === 0 ? (
            <Empty icon={KeyRound} title="No trusted publishers" className="py-10" />
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
