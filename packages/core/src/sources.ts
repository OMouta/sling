/**
 * Sources: files and links a personality answers from, and files attached
 * to a message in a chat. The server extracts their text once and searches
 * it with Postgres full-text search.
 */

import type { AssistantChoice } from "./models.ts";
import type {
  GlyphShape,
  PersonalityColor,
  PersonalityTool,
  PersonalityView,
} from "./personalities.ts";

export const SOURCE_KINDS = ["file", "link", "image"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATES = ["processing", "ready", "failed"] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/** Largest file a source or attachment may be. */
export const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** Most text kept from one source. */
export const SOURCE_MAX_CHARS = 2_000_000;
export const PERSONALITY_MAX_SOURCES = 50;
export const MESSAGE_MAX_FILES = 10;
export const MESSAGE_MAX_IMAGES = 4;
/** All of one message's images together, after the browser shrinks them. */
export const MESSAGE_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Longest side of an image after the browser shrinks it. */
export const IMAGE_MAX_SIDE = 2048;
/** A document in chat shorter than this goes to the model whole. */
export const INLINE_DOCUMENT_CHARS = 20_000;

/** Files a source or attachment can be, by media type. Images are attachments only. */
export const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "text/plain": "Text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "text/html": "HTML",
  "application/json": "JSON",
};
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export interface SourceView {
  id: string;
  /** Set for a personality's source. */
  personalityId: string | null;
  /** Set for a file attached in a chat. */
  conversationId: string | null;
  /** The message a chat file was sent with, once it's sent. */
  messageId: string | null;
  kind: SourceKind;
  name: string;
  mediaType: string;
  size: number;
  /** A link source's address. */
  url: string | null;
  state: SourceState;
  /** Why it failed, in words for the user. */
  error: string | null;
  /** Pages for a PDF, null for anything without pages. */
  pages: number | null;
  chars: number;
  createdAt: string;
}

/** A source the assistant cited in a reply. */
export interface ReplySource {
  /** The number the reply cites it by. */
  n: number;
  url: string;
  title: string;
  kind: "web" | "document";
  /** For a document: which source, and the page cited. */
  sourceId?: string;
  page?: number;
}

export type FeedbackRating = "up" | "down";

/** A downvote on a personality's page. */
export interface FeedbackItemView {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  rating: FeedbackRating;
  reason: string;
  /** The start of the reply. */
  excerpt: string;
  revision: number;
  createdAt: string;
}

export interface FeedbackSummaryView {
  /** The personality's current revision, which the counts are for. */
  revision: number;
  up: number;
  down: number;
  /** The latest downvotes on any revision, newest first. */
  recent: FeedbackItemView[];
}

/** New instructions the personality's model wrote from its downvotes. */
export interface InstructionsSuggestionView {
  instructions: string;
  /** A line on what changed. */
  summary: string;
  /** How many downvotes it read. */
  basedOn: number;
}

export const PERSONALITY_EXPORT_FORMAT = "sling.personality/v1";

/** A personality as a file, to back up or share. */
export interface PersonalityExport {
  format: typeof PERSONALITY_EXPORT_FORMAT;
  name: string;
  description: string;
  instructions: string;
  tools: PersonalityTool[];
  color: PersonalityColor;
  shape: GlyphShape;
  assistant: AssistantChoice | null;
  sources: PersonalityExportSource[];
}

export type PersonalityExportSource =
  | { kind: "file"; name: string; mediaType: string; data: string }
  | { kind: "link"; name: string; url: string };

/** What importing a personality file answers. */
export interface PersonalityImportView {
  personality: PersonalityView;
  /** Sources in the file that couldn't be added. */
  sourcesFailed: number;
}

/** A size for people: "512 KB", "1.2 MB", "3 GB". Under 10 of a unit keeps one decimal. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const shown = i === 0 || n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[i]}`;
}

/** What uploaded files take up in a workspace, and the most they may. */
export interface StorageUsageView {
  /** Bytes stored, in all. */
  used: number;
  /** The most files may take, in bytes. Zero means no limit. */
  limit: number;
  /** Files sent in chats, which stay with their messages. */
  chats: number;
  /** Personalities' sources, which can be removed from each personality. */
  personalities: number;
}
