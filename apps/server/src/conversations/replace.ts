import type { schema } from "@sling/db";

type MessageRow = typeof schema.messages.$inferSelect;

/**
 * The messages Retry (a reply) or Edit (a user message) may replace: the
 * latest of their kind, when nothing after them did anything outside the
 * chat. None until retry and edit are built.
 */
export function replaceableIds(_rows: readonly MessageRow[]): Set<string> {
  return new Set();
}
