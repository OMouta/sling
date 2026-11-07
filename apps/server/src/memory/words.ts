/**
 * Postgres's English stop words. The search column also holds every word as
 * written, stop words included, so a query keeps only the words that say
 * something: "who is my dentist" looks for "who" and "dentist", not for
 * every memory with "is" or "my" in it.
 */
const STOP = new Set(
  (
    "i me my myself we our ours ourselves you your yours yourself yourselves he him his himself " +
    "she her hers herself it its itself they them their theirs themselves what which who whom " +
    "this that these those am is are was were be been being have has had having do does did doing " +
    "a an the and but if or because as until while of at by for with about against between into " +
    "through during before after above below to from up down in out on off over under again " +
    "further then once here there when where why how all any both each few more most other some " +
    "such no nor not only own same so than too very s t can will just don should now"
  ).split(" "),
);

/** Most words one search looks for. */
const MAX_WORDS = 12;

/**
 * The words of a search, lowercased, without stop words or repeats. Only
 * letters and digits, so they're safe to put in a tsquery as they are.
 */
export function searchWords(query: string): string[] {
  const all = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = all.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : all)].slice(0, MAX_WORDS);
}
