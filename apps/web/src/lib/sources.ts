import type { ServerEvent, SourceView } from "@sling/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Link2,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api.ts";
import type { ConversationDetail } from "./types.ts";

export const sourcesKey = (personalityId: string) => ["sources", personalityId] as const;

export function useSources(personalityId: string) {
  return useQuery({
    queryKey: sourcesKey(personalityId),
    queryFn: ({ signal }) =>
      api.get<SourceView[]>(`/api/personalities/${personalityId}/sources`, { signal }),
  });
}

/** Uploads a file's bytes, as a personality's source or for the next message. */
export function uploadSource(path: string, file: Blob, name: string): Promise<SourceView> {
  return api.post<SourceView>(`${path}?name=${encodeURIComponent(name)}`, file);
}

/** Where a citation or a chip opens a source: a PDF at its page, a link at its page. */
export const viewUrl = (s: Pick<SourceView, "id">, page?: number) =>
  `/api/sources/${s.id}/view${page ? `?page=${page}` : ""}`;
export const fileUrl = (s: Pick<SourceView, "id">) => `/api/sources/${s.id}/file`;

type Listener = (ev: Extract<ServerEvent, { type: "source.updated" | "source.removed" }>) => void;
const listeners = new Set<Listener>();

/** Hears every source change, for files waiting in a composer. */
export function onSourceEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Keeps a personality's list and a chat's sent files current. */
export function applySourceEvent(
  qc: QueryClient,
  ev: Extract<ServerEvent, { type: "source.updated" | "source.removed" }>,
) {
  // What files take up changes with them; Settings shows it when open.
  void qc.invalidateQueries({ queryKey: ["storage"] });
  if (ev.type === "source.updated") {
    const s = ev.source;
    if (s.personalityId) {
      qc.setQueryData<SourceView[]>(sourcesKey(s.personalityId), (list) => {
        if (!list) return list;
        return list.some((x) => x.id === s.id)
          ? list.map((x) => (x.id === s.id ? s : x))
          : [...list, s];
      });
    }
    if (s.conversationId && s.messageId) {
      qc.setQueryData<ConversationDetail>(["conversation", s.conversationId], (d) =>
        d
          ? {
              ...d,
              messages: d.messages.map((m) =>
                m.id === s.messageId
                  ? { ...m, attachments: m.attachments.map((a) => (a.id === s.id ? s : a)) }
                  : m,
              ),
            }
          : d,
      );
    }
  } else {
    qc.setQueriesData<SourceView[]>({ queryKey: ["sources"] }, (list) =>
      list?.filter((x) => x.id !== ev.id),
    );
  }
  for (const fn of listeners) fn(ev);
}

/** What a source is, in a word. */
export function kindLabel(s: Pick<SourceView, "kind" | "mediaType">): string {
  if (s.kind === "link") return "Link";
  if (s.kind === "image") return "Image";
  switch (s.mediaType) {
    case "application/pdf":
      return "PDF";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "Word";
    case "text/markdown":
      return "Markdown";
    case "text/csv":
      return "CSV";
    case "application/json":
      return "JSON";
    case "text/html":
      return "HTML";
    default:
      return "Text";
  }
}

export function kindIcon(s: Pick<SourceView, "kind" | "mediaType">): LucideIcon {
  if (s.kind === "link") return Link2;
  if (s.kind === "image" || s.mediaType.startsWith("image/")) return ImageIcon;
  if (s.mediaType === "text/csv") return FileSpreadsheet;
  if (s.mediaType === "application/json" || s.mediaType === "text/html") return FileCode;
  if (s.mediaType === "application/pdf" || s.mediaType.startsWith("text/")) return FileText;
  if (s.mediaType.includes("wordprocessingml")) return FileText;
  return File;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

/** The short line under a source's name: its pages, or its size. */
export function sourceDetail(s: SourceView): string {
  if (s.pages) return `${s.pages} page${s.pages === 1 ? "" : "s"}`;
  if (s.kind === "link" && s.url) {
    try {
      return new URL(s.url).host;
    } catch {
      return s.url;
    }
  }
  return s.size ? fileSize(s.size) : kindLabel(s);
}

/** Files a document picker offers. Images are for chats only. */
export const DOCUMENT_ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm,application/pdf,text/*,application/json";
export const ATTACHMENT_ACCEPT = `${DOCUMENT_ACCEPT},image/jpeg,image/png,image/webp,image/gif`;

/** Opens the system file picker, and passes on what was picked. */
export function pickFiles(accept: string, onFiles: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = accept;
  input.hidden = true;
  // Some browsers only open a picker that's in the page.
  document.body.append(input);
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (files.length) onFiles(files);
  });
  input.addEventListener("cancel", () => input.remove());
  input.click();
}

/**
 * How many sources an imported personality's file had that couldn't be
 * added, kept from the import until its Sources section has shown it once.
 */
const importMisses = new Map<string, number>();

export function noteImportMisses(personalityId: string, count: number) {
  if (count > 0) importMisses.set(personalityId, count);
}

export function takeImportMisses(personalityId: string): number {
  const n = importMisses.get(personalityId) ?? 0;
  importMisses.delete(personalityId);
  return n;
}
