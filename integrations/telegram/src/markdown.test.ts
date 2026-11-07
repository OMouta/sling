import { describe, expect, it } from "vitest";
import { inlineHtml, MESSAGE_LIMIT, telegramMessages, visibleText } from "./markdown.ts";

const html = (md: string) => telegramMessages(md).map((m) => m.html);

describe("inlineHtml", () => {
  it("turns emphasis, code, and links into Telegram's tags, and escapes the rest", () => {
    expect(inlineHtml("**Bold**, *italic*, _also_, ~~gone~~ and `a < b`")).toBe(
      "<b>Bold</b>, <i>italic</i>, <i>also</i>, <s>gone</s> and <code>a &lt; b</code>",
    );
    expect(inlineHtml("See [the docs](https://example.com/a?b=1&c=2) & <https://sling.dev>")).toBe(
      'See <a href="https://example.com/a?b=1&amp;c=2">the docs</a> &amp; <a href="https://sling.dev">https://sling.dev</a>',
    );
  });

  it("leaves things that only look like formatting alone", () => {
    expect(inlineHtml("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
    expect(inlineHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
    expect(inlineHtml("[click](javascript:alert(1))")).toBe("[click](javascript:alert(1))");
    expect(inlineHtml("<b>typed tags</b>")).toBe("&lt;b&gt;typed tags&lt;/b&gt;");
  });
});

describe("telegramMessages", () => {
  it("renders headings, lists, quotes, code blocks, and tables", () => {
    const md = [
      "# This week",
      "",
      "- **Mon** standup",
      "* Tue: dentist",
      "1. first",
      "",
      "> Jo said",
      "> it's paid",
      "",
      "```ts",
      "const a = 1 < 2;",
      "```",
      "",
      "| Day | What |",
      "|-----|------|",
      "| Mon | Gym |",
      "",
      "---",
    ].join("\n");
    expect(html(md)).toEqual([
      [
        "<b>This week</b>",
        "• <b>Mon</b> standup\n• Tue: dentist\n1. first",
        "<blockquote>Jo said\nit's paid</blockquote>",
        '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
        "<pre>| Day | What |\n| Mon | Gym |</pre>",
      ].join("\n\n"),
    ]);
  });

  it("keeps a plain-text copy of each message", () => {
    expect(telegramMessages("**Hi** <there> & `x`")).toEqual([
      { html: "<b>Hi</b> &lt;there&gt; &amp; <code>x</code>", text: "Hi <there> & x" },
    ]);
  });

  it("splits between paragraphs, keeping each message under the limit", () => {
    const para = (n: number) => `${"word ".repeat(300).trim()} ${n}`;
    const md = Array.from({ length: 6 }, (_, i) => para(i)).join("\n\n");
    const out = telegramMessages(md);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(visibleText(m.html).length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    // Nothing is lost or reordered.
    expect(out.map((m) => m.text).join("\n\n")).toBe(md);
  });

  it("splits one huge paragraph at spaces, and a long code block between lines", () => {
    const long = "x".repeat(50).concat(" ").repeat(200);
    const out = telegramMessages(long, 1000);
    expect(out.length).toBeGreaterThan(5);
    for (const m of out) expect(m.text.length).toBeLessThanOrEqual(1000);

    const code = `\`\`\`\n${Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n")}\n\`\`\``;
    const pieces = telegramMessages(code, 1000);
    expect(pieces.length).toBeGreaterThan(3);
    for (const m of pieces) {
      expect(m.html.startsWith("<pre>")).toBe(true);
      expect(m.html.endsWith("</pre>")).toBe(true);
      expect(m.text.length).toBeLessThanOrEqual(1000);
    }
    expect(pieces.map((m) => m.text).join("\n")).toBe(code.split("\n").slice(1, -1).join("\n"));
  });

  it("counts the text people see, not the tags", () => {
    const bold = `**${"b".repeat(4000)}**`;
    expect(telegramMessages(bold)).toHaveLength(1);
    const escaped = "&".repeat(4000);
    expect(telegramMessages(escaped)).toEqual([{ html: "&amp;".repeat(4000), text: escaped }]);
  });

  it("sends nothing for an empty reply", () => {
    expect(telegramMessages("  \n\n ")).toEqual([]);
  });
});
