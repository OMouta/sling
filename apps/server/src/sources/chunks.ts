/** About how long a chunk is. None is longer. */
export const CHUNK_CHARS = 1_500;

export interface Chunk {
  /** The PDF page it's on, from 1. Null for text without pages. */
  page: number | null;
  text: string;
}

/** A piece too long for one chunk, cut at lines, then sentences, then words. */
function pieces(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  for (const [split, sep] of [
    [/\n/, "\n"],
    [/(?<=[.!?;:])\s+/, " "],
    [/\s+/, " "],
  ] as const) {
    const parts = text.split(split).filter((p) => p.trim());
    if (parts.length > 1) return pack(parts.flatMap(pieces), sep);
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) out.push(text.slice(i, i + CHUNK_CHARS));
  return out;
}

/** Joins parts into runs of at most CHUNK_CHARS. */
function pack(parts: string[], sep: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!current) current = part;
    else if (current.length + sep.length + part.length <= CHUNK_CHARS) current += sep + part;
    else {
      out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits text into chunks for search: by page, then by paragraph, packed
 * into runs of about CHUNK_CHARS. A chunk never spans two pages, so a
 * search hit always knows its page.
 */
export function chunkPages(pages: readonly string[], paged: boolean): Chunk[] {
  const out: Chunk[] = [];
  for (const [i, text] of pages.entries()) {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap(pieces);
    for (const t of pack(paragraphs, "\n\n")) out.push({ page: paged ? i + 1 : null, text: t });
  }
  return out;
}
