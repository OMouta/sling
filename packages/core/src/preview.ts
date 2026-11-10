/**
 * A message as one line for a list: the text its Markdown shows, on one
 * line, cut at 160 characters. A note from Sling shows its first line only.
 */
export function previewText(text: string, role: string): string {
  const line = role === "system" ? (text.trim().split("\n")[0] ?? "") : text;
  const flat = plainText(line).replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

/** Markdown as the text it shows, without its marks. */
export function plainText(markdown: string): string {
  return (
    markdown
      // Lines that are only marks: code fences, rules, and a table's divider.
      .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
      .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+(?:[ \t]*:?-{3,}:?[ \t]*)?$/gm, "")
      // Marks at the start of a line.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
        row
          .split("|")
          .map((cell) => cell.trim())
          .join(" "),
      )
      // Inline marks.
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      .replace(/(`+)([^`\n]+?)\1/g, "$2")
      .replace(/(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g, "$2")
      .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, "$1")
      .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/gm, "$1$2")
      .replace(/(^|[^\w\\])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/gm, "$1$2")
  );
}
