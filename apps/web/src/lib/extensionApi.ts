import type {
  CatalogPreviewView,
  CatalogView,
  DiscoverEntryView,
  ExtensionDetailView,
  ExtensionPreview,
  ExtensionView,
  PublisherView,
} from "@sling/core";
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, api, saveBlob } from "./api.ts";
import { qk } from "./workflowApi.ts";

export function useExtensions(enabled = true) {
  return useQuery({
    queryKey: qk.extensions(),
    queryFn: ({ signal }) => api.get<ExtensionView[]>("/api/extensions", { signal }),
    enabled,
  });
}

export function useExtension(id: string | null) {
  return useQuery({
    queryKey: qk.extension(id ?? ""),
    queryFn: ({ signal }) =>
      api.get<ExtensionDetailView>(`/api/extensions/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: id !== null,
  });
}

/** Every entry from every catalog, filtered on the page so typing never waits on the server. */
export function useDiscover(enabled = true) {
  return useQuery({
    queryKey: qk.discover(),
    queryFn: ({ signal }) => api.get<DiscoverEntryView[]>("/api/extensions/discover", { signal }),
    enabled,
  });
}

export function useCatalogs(enabled = true) {
  return useQuery({
    queryKey: qk.catalogs(),
    queryFn: ({ signal }) => api.get<CatalogView[]>("/api/extension-catalogs", { signal }),
    enabled,
  });
}

export function usePublishers(enabled = true) {
  return useQuery({
    queryKey: qk.publishers(),
    queryFn: ({ signal }) => api.get<PublisherView[]>("/api/extension-publishers", { signal }),
    enabled,
  });
}

/** Where a preview comes from: a catalog entry, a file, or a newer version of one installed. */
export type PreviewSource =
  | {
      kind: "catalog";
      catalogId: string;
      extensionId: string;
      version: string;
      name: string;
      description?: string;
    }
  | { kind: "upload"; file: File }
  | { kind: "update"; extensionId: string; version: string; name: string };

const path = (id: string) => `/api/extensions/${encodeURIComponent(id)}`;

export const extensionApi = {
  preview: (source: PreviewSource) => {
    switch (source.kind) {
      case "catalog":
        return api.post<ExtensionPreview>("/api/extensions/preview", {
          catalogId: source.catalogId,
          extensionId: source.extensionId,
          version: source.version,
        });
      case "upload":
        return api.post<ExtensionPreview>("/api/extensions/preview", source.file);
      case "update":
        return api.post<ExtensionPreview>(`${path(source.extensionId)}/update/preview`, {
          version: source.version,
        });
    }
  },
  /** Confirms a preview. The server refuses if what it staged changed since. */
  install: (preview: ExtensionPreview, trustPublisher: boolean) =>
    api.post<ExtensionView>("/api/extensions/install", {
      stagingId: preview.stagingId,
      digest: preview.digest,
      permissions: preview.permissionsKey,
      trustPublisher,
    }),
  setEnabled: (id: string, enabled: boolean) =>
    api.patch<ExtensionView | null>(path(id), { enabled }),
  remove: (id: string) => api.del<unknown>(path(id)),
  previewCatalog: (url: string) =>
    api.post<CatalogPreviewView>("/api/extension-catalogs/preview", { url }),
  addCatalog: (url: string) => api.post<CatalogView>("/api/extension-catalogs", { url }),
  refreshCatalog: (id: string) =>
    api.post<CatalogView | null>(`/api/extension-catalogs/${encodeURIComponent(id)}/refresh`),
  removeCatalog: (id: string) =>
    api.del<unknown>(`/api/extension-catalogs/${encodeURIComponent(id)}`),
  removePublisher: (keyId: string) =>
    api.del<unknown>(`/api/extension-publishers/${encodeURIComponent(keyId)}`),
  /** Builds a package from a workflow and saves it. */
  exportPackage: async (
    workflowId: string,
    body: { id: string; version: string; name: string },
  ) => {
    const { blob, fileName } = await api.download(
      `/api/workflows/${encodeURIComponent(workflowId)}/export-package`,
      body,
      `${body.id}-${body.version}.slx`,
    );
    saveBlob(fileName, blob);
  },
};

/** Turns an extension on or off, showing the switch's new state right away. */
export function useSetEnabled(id: string) {
  const qc = useQueryClient();
  const patch = (enabled: boolean) => {
    qc.setQueryData<ExtensionView[]>(qk.extensions(), (list) =>
      list?.map((x) => (x.id === id ? { ...x, enabled } : x)),
    );
    qc.setQueryData<ExtensionDetailView>(qk.extension(id), (d) => (d ? { ...d, enabled } : d));
  };
  return useMutation({
    mutationFn: (enabled: boolean) => extensionApi.setEnabled(id, enabled),
    onMutate: patch,
    onSuccess: (res) => {
      if (isExtensionView(res)) applyExtension(qc, res, { changed: true });
      else void qc.invalidateQueries({ queryKey: qk.extensions() });
    },
    onError: (_err, enabled) => patch(!enabled),
  });
}

/** The icon an extension ships. The version busts the browser's cache after an update. */
export function extensionIconUrl(ext: { id: string; version: string }): string {
  return `${path(ext.id)}/icon?v=${encodeURIComponent(ext.version)}`;
}

/**
 * The staged package is gone (410) or no longer matches what was shown (409),
 * so the only way on is a fresh preview.
 */
export function isStalePreview(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 409 || err.status === 410);
}

export function isExtensionView(value: unknown): value is ExtensionView {
  return typeof value === "object" && value !== null && "id" in value && "contents" in value;
}

export function isCatalogView(value: unknown): value is CatalogView {
  return typeof value === "object" && value !== null && "id" in value && "included" in value;
}

/** Refetch only queries that are on screen; the rest refetch when they're next used. */
function refresh(qc: QueryClient, keys: QueryKey[]) {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey }, { cancelRefetch: false });
}

/**
 * An extension was installed or changed. The list and its details patch in
 * place. Connectors, nodes, templates, and Discover all carry what extensions
 * add or their installed version, so those refetch, but only when that
 * changed: a process starting or stopping is just a status.
 */
export function applyExtension(qc: QueryClient, ext: ExtensionView, opts?: { changed?: boolean }) {
  let prev: ExtensionView | undefined;
  let cached = false;
  qc.setQueryData<ExtensionView[]>(qk.extensions(), (list) => {
    if (!list) return list;
    cached = true;
    prev = list.find((x) => x.id === ext.id);
    return prev ? list.map((x) => (x.id === ext.id ? ext : x)) : [...list, ext];
  });
  qc.setQueryData<ExtensionDetailView>(qk.extension(ext.id), (d) => (d ? { ...d, ...ext } : d));

  const added = cached && !prev;
  const changed =
    opts?.changed ||
    !cached ||
    !prev ||
    prev.version !== ext.version ||
    prev.enabled !== ext.enabled;
  if (changed) {
    refresh(qc, [qk.connectors(), qk.catalog(), qk.templates(), qk.discover()]);
  } else if (prev?.update?.version !== ext.update?.version) {
    refresh(qc, [qk.discover()]);
  }
  if (prev && prev.version !== ext.version) refresh(qc, [qk.extension(ext.id)]);
  if (added || !cached) refresh(qc, [qk.publishers()]);
}

/** An extension was removed, with its installations, templates, and nodes. */
export function forgetExtension(qc: QueryClient, id: string) {
  qc.setQueryData<ExtensionView[]>(qk.extensions(), (list) => list?.filter((x) => x.id !== id));
  qc.removeQueries({ queryKey: qk.extension(id), exact: true });
  refresh(qc, [
    qk.publishers(),
    qk.connectors(),
    qk.installations(),
    qk.catalog(),
    qk.templates(),
    qk.discover(),
  ]);
}
