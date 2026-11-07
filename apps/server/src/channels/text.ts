/**
 * Markdown as plain text, for apps that show a message as it was typed, such
 * as iMessage and Signal. Emphasis and heading marks go, links become
 * "text (url)", and bullets "•". Code stays as written, without its fences.
 */
export function plainText(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("");
      continue;
    }
    const l = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1• ")
      .replace(/^(\s*)[-*+]\s+/, "$1• ");
    out.push(inline(l));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inline marks, leaving code spans as they are apart from their backticks. */
function inline(line: string): string {
  return line
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? part.slice(1, -1)
        : part
            .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, url: string) =>
              alt ? `${alt} (${url})` : url,
            )
            .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text: string, url: string) =>
              text === url ? url : `${text} (${url})`,
            )
            .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
            .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
            .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1$2")
            .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1$2")
            .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1"),
    )
    .join("");
}
