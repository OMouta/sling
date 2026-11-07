/**
 * The assistant writes Markdown; Telegram shows a small HTML subset (b, i,
 * s, code, pre, a, blockquote). This turns one into the other, and splits a
 * long reply into messages under Telegram's 4,096 characters, which counts
 * the text people see, not the tags.
 */

/** Longest message Telegram takes, in characters after its formatting is read. */
export const MESSAGE_LIMIT = 4096;

export interface TelegramText {
  /** For `parse_mode: "HTML"`. */
  html: string;
  /** The same message without formatting, for when Telegram can't read the HTML. */
  text: string;
}

/** Text, a quote, or a table: lines that render together. */
interface LinesBlock {
  kind: "quote" | "table" | "text";
  lines: string[];
}

type Block = { kind: "code"; lang: string; lines: string[] } | LinesBlock;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** What a reader sees of some Telegram HTML. */
export function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const SAFE_LINK = /^(https?:\/\/|mailto:|tg:\/\/)/i;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const TABLE_RULE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$/;

/** Bold, italics, strikethrough, inline code, and links within one line or paragraph. */
export function inlineHtml(source: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\uE000${held.push(html) - 1}\uE000`;
  let s = source.replace(/\uE000/g, "");
  // Code first, so nothing inside it is read as formatting.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) =>
    hold(`<code>${escapeHtml(code)}</code>`),
  );
  s = s.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (whole, label: string, url: string) =>
      SAFE_LINK.test(url)
        ? hold(`<a href="${escapeAttr(url)}">${formatting(escapeHtml(label))}</a>`)
        : whole,
  );
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url: string) =>
    hold(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`),
  );
  s = formatting(escapeHtml(s));
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => held[Number(i)] ?? "");
}

/** Emphasis on text that's already escaped. */
function formatting(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "<b>$1</b>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>")
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/g, "<i>$1</i>");
}

/** Markdown in blocks: code, quotes, tables, and text, each with its lines. */
function blocksOf(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let open: LinesBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence || !line.trim()) {
      if (open) out.push(open);
      open = null;
    }
    if (fence) {
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim().startsWith(fence[1] ?? "```")) break;
        code.push(l);
      }
      out.push({ kind: "code", lang: fence[2] ?? "", lines: code });
      i = j;
      continue;
    }
    if (!line.trim()) continue;
    const kind: LinesBlock["kind"] = /^\s*>/.test(line)
      ? "quote"
      : /^\s*\|.*\|\s*$/.test(line)
        ? "table"
        : "text";
    if (!open || open.kind !== kind) {
      if (open) out.push(open);
      open = { kind, lines: [] };
    }
    open.lines.push(line);
  }
  if (open) out.push(open);
  return out;
}

/** One line of text: headings bold, list markers as bullets, rules dropped. */
function textLine(line: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "";
  const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${inlineHtml(heading[1] ?? "")}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1] ?? ""}• ${inlineHtml(bullet[2] ?? "")}`;
  return inlineHtml(line);
}

function render(block: Block): string {
  switch (block.kind) {
    case "code": {
      const code = escapeHtml(block.lines.join("\n"));
      return block.lang
        ? `<pre><code class="language-${escapeAttr(block.lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`;
    }
    case "quote":
      return `<blockquote>${block.lines.map((l) => inlineHtml(l.replace(/^\s*>\s?/, ""))).join("\n")}</blockquote>`;
    case "table": {
      // A table reads best in a fixed-width font. Its |---| line is only for Markdown.
      const rows = block.lines.filter((l) => !TABLE_RULE.test(l));
      return `<pre>${escapeHtml(rows.map((l) => l.trim()).join("\n"))}</pre>`;
    }
    default:
      return block.lines
        .map(textLine)
        .join("\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
  }
}

/** A string cut into pieces of at most `limit` characters, at a space when there's one near. */
function cut(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let at = rest.lastIndexOf(" ", limit);
    if (at < limit / 2) at = limit;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^ /, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** A block whose text is longer than a message, as blocks that fit, split between lines. */
function split(block: Block, limit: number): Block[] {
  // Markdown's own characters only ever disappear when it's rendered, so source
  // that fits always renders to text that fits.
  const room = block.kind === "code" ? limit : limit - 2;
  const pieces: string[][] = [];
  let lines: string[] = [];
  let size = 0;
  for (const line of block.lines) {
    for (const part of cut(line, room)) {
      if (lines.length > 0 && size + 1 + part.length > room) {
        pieces.push(lines);
        lines = [];
        size = 0;
      }
      size += (lines.length > 0 ? 1 : 0) + part.length;
      lines.push(part);
    }
  }
  if (lines.length > 0) pieces.push(lines);
  return pieces.map((l) => ({ ...block, lines: l }));
}

/** Markdown as Telegram messages: HTML, each under the limit, split between blocks first. */
export function telegramMessages(markdown: string, limit = MESSAGE_LIMIT): TelegramText[] {
  const parts: { html: string; length: number }[] = [];
  for (const block of blocksOf(markdown)) {
    const html = render(block);
    const length = visibleText(html).length;
    if (!html) continue;
    if (length <= limit) {
      parts.push({ html, length });
      continue;
    }
    for (const piece of split(block, limit)) {
      const h = render(piece);
      if (h) parts.push({ html: h, length: visibleText(h).length });
    }
  }
  const out: TelegramText[] = [];
  let html = "";
  let length = 0;
  for (const p of parts) {
    if (html && length + 2 + p.length > limit) {
      out.push({ html, text: visibleText(html) });
      html = "";
      length = 0;
    }
    html = html ? `${html}\n\n${p.html}` : p.html;
    length += (length > 0 ? 2 : 0) + p.length;
  }
  if (html) out.push({ html, text: visibleText(html) });
  return out;
}
