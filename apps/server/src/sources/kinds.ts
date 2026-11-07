import type { IMAGE_TYPES } from "@sling/core";

export const PDF = "application/pdf";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const HTML = "text/html";

/** What a file is, from its first bytes and its name. */
export type Detected =
  | { kind: "file"; mediaType: string }
  | { kind: "image"; mediaType: (typeof IMAGE_TYPES)[number] }
  | { refused: string };

const TEXT_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  csv: "text/csv",
  tsv: "text/csv",
  json: "application/json",
  html: HTML,
  htm: HTML,
};

/** Text and code that's read as plain UTF-8. */
const PLAIN = new Set(
  (
    "txt text log ini cfg conf toml yaml yml xml rst tex org srt vtt env properties " +
    "c h cc cpp hpp cs go rs java kt kts swift m mm py rb php pl lua r jl scala clj ex exs erl hs " +
    "ml fs dart js mjs cjs jsx ts tsx vue svelte css scss less sql sh bash zsh fish ps1 bat " +
    "gradle make cmake dockerfile tf proto graphql gql ipynb"
  ).split(" "),
);

function extension(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (base === "dockerfile" || base === "makefile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A ZIP names its files in its headers; a Word file has word/document.xml. */
function isDocx(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
    "word/document.xml",
  );
}

/** Binary data has NUL bytes near the start, which text never does. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const READS = "Sling reads PDFs, Word files, text, Markdown, CSV, JSON, HTML, and images.";

/**
 * What an uploaded file is. The bytes decide where they can, and the name
 * otherwise, so a renamed file is read as what it is. Text that turns out
 * not to be UTF-8 fails later, when it's read.
 */
export function detect(bytes: Uint8Array, name: string): Detected {
  if (startsWith(bytes, ascii("%PDF-"))) return { kind: "file", mediaType: PDF };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mediaType: "image/png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mediaType: "image/jpeg" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return { kind: "image", mediaType: "image/webp" };
  }
  const ext = extension(name);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (isDocx(bytes)) return { kind: "file", mediaType: DOCX };
    return { refused: `Sling can't read this kind of file. ${READS}` };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    return {
      refused:
        ext === "doc"
          ? "Sling reads Word files saved as .docx. Save it as .docx and upload that."
          : `Sling can't read this kind of file. ${READS}`,
    };
  }
  const byName = TEXT_BY_EXTENSION[ext];
  if (byName) return { kind: "file", mediaType: byName };
  if (PLAIN.has(ext)) return { kind: "file", mediaType: "text/plain" };
  if (looksBinary(bytes)) return { refused: `Sling can't read this kind of file. ${READS}` };
  return { kind: "file", mediaType: "text/plain" };
}

/** The type a fetched page is: by its bytes first, then what the server said. */
export function detectFetched(bytes: Uint8Array, contentType: string): string | null {
  if (startsWith(bytes, ascii("%PDF-"))) return PDF;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === HTML || type === "application/xhtml+xml") return HTML;
  if (type === PDF) return PDF;
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return HTML;
  if (type === "text/markdown" || type === "text/csv" || type === "application/json") return type;
  if (type.startsWith("text/") || type === "") return looksBinary(bytes) ? null : "text/plain";
  return null;
}

/** A short name for a file's type, for the prompt and lists. */
export function typeLabel(mediaType: string): string {
  if (mediaType === PDF) return "PDF";
  if (mediaType === DOCX) return "Word";
  if (mediaType === HTML) return "web page";
  if (mediaType === "text/markdown") return "Markdown";
  if (mediaType === "text/csv") return "CSV";
  if (mediaType === "application/json") return "JSON";
  if (mediaType.startsWith("image/")) return "image";
  return "text";
}
