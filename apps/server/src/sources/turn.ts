/**
 * What a chat turn gets from files: the documents and images sent with its
 * messages, put where the model reads them, and the personality's sources
 * for the prompt. An API model gets images as image parts and documents as
 * text; a CLI gets documents as text and the newest message's images on the
 * side, and older images by name.
 */
import { INLINE_DOCUMENT_CHARS, MESSAGE_MAX_IMAGE_BYTES } from "@sling/core";
import type { schema } from "@sling/db";
import type { ModelMessage } from "ai";
import { textOf } from "../agent/history.ts";
import type { AppContext } from "../context.ts";
import { type PromptSource, sourcesSection } from "./prompt.ts";
import type { SourceRow } from "./views.ts";

type MessageRow = typeof schema.messages.$inferSelect;

/** How long a turn waits for a file that's still being read. */
export const FILE_WAIT_MS = 30_000;
/** Files are looked up on this many of the latest messages, which covers what the model sees. */
const RECENT_ROWS = 80;

export interface TurnImage {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

export interface TurnFiles {
  /** The prompt's part on sources, or empty. */
  section: string;
  /** Whether the turn gets search_sources and read_source. */
  tools: boolean;
  /** The rows with each user message's files in its content, for an API model. */
  forApi(): Promise<MessageRow[]>;
  /** The rows with documents and image names as text, and the newest message's images. */
  forCli(): Promise<{ rows: MessageRow[]; images: TurnImage[] }>;
}

const attr = (s: string) => s.replace(/[\n\r"]/g, " ");

/** A document as the model reads it, or a line saying why it can't be read whole. */
function documentText(f: SourceRow, text: string | undefined): string {
  const pages = f.pages ? ` (${f.pages} page${f.pages === 1 ? "" : "s"})` : "";
  if (f.state === "processing") {
    return `[Attached: ${f.name}. It's still being read, so it isn't available yet.]`;
  }
  if (f.state === "failed") {
    return `[Attached: ${f.name}. Sling couldn't read it: ${f.error ?? "unknown error"}]`;
  }
  if (text === undefined) {
    return `[Attached: ${f.name}${pages}. It's too long to include here: use search_sources and read_source to read it.]`;
  }
  const body = text.replace(/<\/document>/gi, "</ document>");
  return `<document name="${attr(f.name)}"${f.pages ? ` pages="${f.pages}"` : ""}>\n${body}\n</document>`;
}

/** The index of the last assistant reply: what comes after it is this turn's to answer. */
function lastAnswer(rows: readonly MessageRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.role === "assistant") return i;
  return -1;
}

const promptSource = (r: SourceRow): PromptSource => ({
  name: r.name,
  kind: r.kind,
  mediaType: r.mediaType,
  pages: r.pages,
});

/**
 * Loads a turn's files: the personality's sources, and the files sent with
 * the chat's recent messages, waiting up to FILE_WAIT_MS for any still
 * being read.
 */
export async function turnFiles(
  ctx: AppContext,
  conv: { workspaceId: string },
  personalityId: string | null,
  rows: readonly MessageRow[],
): Promise<TurnFiles> {
  const userIds = rows
    .slice(-RECENT_ROWS)
    .filter((r) => r.role === "user")
    .map((r) => r.id);
  let [sources, files] = await Promise.all([
    personalityId ? ctx.sources.forPersonality(conv.workspaceId, personalityId) : [],
    ctx.sources.forMessages(conv.workspaceId, userIds),
  ]);
  const waiting = files.filter((f) => f.state === "processing").map((f) => f.id);
  if (waiting.length) {
    const now = new Map(
      (await ctx.sources.settled(conv.workspaceId, waiting, FILE_WAIT_MS)).map((r) => [r.id, r]),
    );
    files = files.map((f) => now.get(f.id) ?? f);
  }
  const ready = sources.filter((r) => r.state === "ready");
  const docs = files.filter((f) => f.kind !== "image");
  const readyDocs = docs.filter((f) => f.state === "ready");
  const byMessage = new Map<string, SourceRow[]>();
  for (const f of files) {
    if (!f.messageId) continue;
    byMessage.set(f.messageId, [...(byMessage.get(f.messageId) ?? []), f]);
  }

  let texts: Promise<Map<string, string>> | null = null;
  const inlineTexts = () => {
    texts ??= ctx.sources.texts(
      readyDocs.filter((f) => f.chars < INLINE_DOCUMENT_CHARS).map((f) => f.id),
    );
    return texts;
  };
  /** The message's text with its documents before it, and its images by name when asked. */
  const withDocs = async (row: MessageRow, list: SourceRow[], imageNames: boolean) => {
    const t = await inlineTexts();
    const parts = [
      ...list.filter((f) => f.kind !== "image").map((f) => documentText(f, t.get(f.id))),
      ...(imageNames
        ? list.filter((f) => f.kind === "image").map((f) => `[image: ${f.name}]`)
        : []),
      textOf((row.content as ModelMessage).content).trim(),
    ].filter(Boolean);
    return parts.join("\n\n");
  };
  const replaced = (row: MessageRow, content: ModelMessage["content"]): MessageRow => ({
    ...row,
    content: { role: "user", content } as ModelMessage,
  });

  return {
    section: sourcesSection(ready.map(promptSource), readyDocs.map(promptSource)),
    tools: ready.length > 0 || readyDocs.length > 0,

    async forApi() {
      if (byMessage.size === 0) return [...rows];
      const imageIds = files.filter((f) => f.kind === "image").map((f) => f.id);
      const bytes = await ctx.sources.bytes(imageIds);
      return Promise.all(
        rows.map(async (row) => {
          const list = byMessage.get(row.id);
          if (!list || row.role !== "user") return row;
          const images = list.flatMap((f) => {
            const data = f.kind === "image" ? bytes.get(f.id) : undefined;
            return data ? [{ type: "file" as const, data, mediaType: f.mediaType }] : [];
          });
          const text = await withDocs(row, list, false);
          return replaced(row, [...images, ...(text ? [{ type: "text" as const, text }] : [])]);
        }),
      );
    },

    async forCli() {
      if (byMessage.size === 0) return { rows: [...rows], images: [] };
      const pending = lastAnswer(rows);
      const newest = rows
        .slice(pending + 1)
        .flatMap((r) => byMessage.get(r.id) ?? [])
        .filter((f) => f.kind === "image");
      const bytes = await ctx.sources.bytes(newest.map((f) => f.id));
      const images: TurnImage[] = [];
      let total = 0;
      for (const f of newest) {
        const data = bytes.get(f.id);
        if (!data || total + data.byteLength > MESSAGE_MAX_IMAGE_BYTES) continue;
        total += data.byteLength;
        images.push({ name: f.name, mediaType: f.mediaType, data });
      }
      const out = await Promise.all(
        rows.map(async (row) => {
          const list = byMessage.get(row.id);
          if (!list || row.role !== "user") return row;
          return replaced(row, await withDocs(row, list, true));
        }),
      );
      return { rows: out, images };
    },
  };
}
