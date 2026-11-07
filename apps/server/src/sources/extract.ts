import { SOURCE_MAX_CHARS } from "@sling/core";
import { DOCX, HTML, PDF } from "./kinds.ts";

/** Why a file's text couldn't be read, in words for the user. */
export class ExtractError extends Error {}

export interface Extracted {
  /** A PDF's text by page, from page 1. One entry for anything without pages. */
  pages: string[];
  /** Whether `pages` are real pages. */
  paged: boolean;
  /** The page's own title, for a web page. */
  title?: string;
  /** Whether text was left out to stay within SOURCE_MAX_CHARS. */
  cut: boolean;
}

const NO_TEXT = "No text found.";

/** Spaces and tabs run together, line ends kept, and at most one blank line. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keeps the text within SOURCE_MAX_CHARS, cutting the last pages first. */
function capped(pages: string[], paged: boolean, title?: string): Extracted {
  let left = SOURCE_MAX_CHARS;
  let cut = false;
  const kept = pages.map((p) => {
    if (p.length <= left) {
      left -= p.length;
      return p;
    }
    cut = true;
    const part = p.slice(0, left);
    left = 0;
    return part;
  });
  return { pages: kept, paged, cut, ...(title ? { title } : {}) };
}

/** UTF-8 text, refused when it isn't. A byte order mark is dropped. */
export function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ExtractError("It isn't UTF-8 text. Save it as UTF-8 and upload it again.");
  }
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js takes the buffer over, so it gets a copy.
    doc = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    if ((err as { name?: string })?.name === "PasswordException") {
      throw new ExtractError("It's password-protected. Remove the password, then upload it again.");
    }
    throw new ExtractError("It isn't a PDF Sling can read. It may be damaged.");
  }
  try {
    const { text } = await extractText(doc, { mergePages: false });
    return text.map(tidy);
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Block elements: their text starts on a new paragraph. */
const BLOCKS = new Set(
  (
    "ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER " +
    "FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TR UL"
  ).split(" "),
);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME"]);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

/** An element's text with its paragraphs, which `textContent` runs together. */
function blockText(root: DomNode): string {
  const out: string[] = [];
  const walk = (n: DomNode) => {
    if (n.nodeType === 3) {
      out.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType !== 1 || SKIP.has(n.nodeName)) return;
    if (n.nodeName === "BR") {
      out.push("\n");
      return;
    }
    const block = BLOCKS.has(n.nodeName);
    if (block) out.push("\n\n");
    if (n.nodeName === "TD" || n.nodeName === "TH") out.push(" ");
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block) out.push("\n\n");
  };
  walk(root);
  return tidy(out.join(""));
}

/** A web page's article: its title and readable text, without menus and ads. */
export async function htmlText(html: string): Promise<{ title?: string; text: string }> {
  const [{ parseHTML }, { Readability }] = await Promise.all([
    import("linkedom"),
    import("@mozilla/readability"),
  ]);
  const { document } = parseHTML(html);
  const pageTitle = document.title?.trim() || undefined;
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
  } catch {
    article = null;
  }
  if (article?.content) {
    const { document: inner } = parseHTML(`<!doctype html><body>${article.content}</body>`);
    const text = blockText(inner.body as unknown as DomNode);
    const title = article.title?.trim() || pageTitle;
    if (text) return { text, ...(title ? { title } : {}) };
  }
  // Readability parses the document in place, so the fallback reads it again.
  // A fragment has no body of its own, so it's read from the top.
  const { document: again } = parseHTML(html);
  const root = again.body?.childNodes.length ? again.body : again.documentElement;
  const text = root ? blockText(root as unknown as DomNode) : "";
  return { text, ...(pageTitle ? { title: pageTitle } : {}) };
}

/** A fetched page's text, in the character set its server named. */
function decoded(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // A character set the runtime doesn't know.
    return new TextDecoder().decode(bytes);
  }
}

/**
 * A document's text: by page for a PDF, and as one piece for everything
 * else. A file is read as UTF-8, and a fetched page in the `charset` its
 * server named. Throws ExtractError with the reason when there's nothing
 * to read.
 */
export async function extract(
  bytes: Uint8Array,
  mediaType: string,
  opts: { charset?: string } = {},
): Promise<Extracted> {
  const read = (b: Uint8Array) => (opts.charset ? decoded(b, opts.charset) : utf8(b));
  if (mediaType === PDF) {
    const pages = await pdfPages(bytes);
    if (!pages.some((p) => p.length > 0)) {
      throw new ExtractError(`${NO_TEXT} It may be a scanned PDF.`);
    }
    return capped(pages, true);
  }
  if (mediaType === DOCX) {
    const mammoth = await import("mammoth");
    let value: string;
    try {
      ({ value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) }));
    } catch {
      throw new ExtractError("It isn't a Word file Sling can read. It may be damaged.");
    }
    const text = tidy(value);
    if (!text) throw new ExtractError(NO_TEXT);
    return capped([text], false);
  }
  if (mediaType === HTML) {
    const { title, text } = await htmlText(read(bytes));
    if (!text) throw new ExtractError(NO_TEXT);
    return capped([text], false, title);
  }
  const text = read(bytes).replace(/\r\n?/g, "\n").trim();
  if (!text) throw new ExtractError(NO_TEXT);
  return capped([text], false);
}
