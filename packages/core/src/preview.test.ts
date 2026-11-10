import { describe, expect, it } from "vitest";
import { plainText, previewText } from "./preview.ts";

describe("a message's preview", () => {
  it("shows what a reply's Markdown says, without its marks", () => {
    const reply = [
      "## Done",
      "",
      "I fixed **the footer** and _the header_, see [the PR](https://github.com/a/b/pull/1).",
      "",
      "- Ran `pnpm test`",
      "- [x] ~~Old~~ step",
      "1. First",
      "> Quoted",
      "",
      "```ts",
      "const year = new Date().getFullYear();",
      "```",
      "",
      "| File | Lines |",
      "|------|------:|",
      "| a.ts | 3 |",
      "---",
      "![chart](https://x.test/c.png) <https://example.com>",
    ].join("\n");
    expect(plainText(reply).replace(/\s+/g, " ").trim()).toBe(
      "Done I fixed the footer and the header, see the PR. Ran pnpm test Old step First Quoted const year = new Date().getFullYear(); File Lines a.ts 3 chart https://example.com",
    );
  });

  it("leaves text that only looks like marks", () => {
    for (const text of [
      "2*3*4 = 24",
      "snake_case_name",
      "a | b",
      "C:\\path\\*glob*",
      "1. 5 * 3 * 2",
    ]) {
      expect(plainText(text), text).toBe(text === "1. 5 * 3 * 2" ? "5 * 3 * 2" : text);
    }
  });

  it("shows a note's first line, and cuts a long message", () => {
    expect(previewText("Task **fix** finished: succeeded.\nMore", "system")).toBe(
      "Task fix finished: succeeded.",
    );
    const long = previewText("word ".repeat(100), "user");
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});
