import type { TraceStep } from "@sling/core";
import { describe, expect, it } from "vitest";
import { collectSources, pagesSeen, siteName } from "./citations.ts";

const search: TraceStep = {
  kind: "tool",
  id: "t1",
  name: "web_search",
  input: { query: "eu ai act" },
  status: "done",
  output: JSON.stringify({
    results: [
      {
        title: "AI Act | Shaping Europe's digital future",
        url: "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai",
      },
      { title: "", url: "https://example.com/untitled" },
    ],
  }),
};
const fetched: TraceStep = {
  kind: "tool",
  id: "t2",
  name: "web_fetch",
  input: { url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj" },
  status: "done",
  output: JSON.stringify({ title: "Regulation (EU) 2024/1689", text: "…" }),
};
const sourceSearch: TraceStep = {
  kind: "tool",
  id: "t3",
  name: "search_sources",
  input: { query: "pets" },
  status: "done",
  output: JSON.stringify([
    {
      sourceId: "src_lease",
      name: "lease.pdf",
      page: 4,
      text: "No pets.",
      link: "https://sling.test/api/sources/src_lease/view?page=4",
    },
  ]),
};

describe("a reply's sources", () => {
  const seen = pagesSeen(
    [search, fetched, sourceSearch],
    new Map([["https://www.bbc.com/news/1", "BBC News"]]),
  );

  it("lists each numbered link once, in the order first cited, titled from what the turn saw", () => {
    const answer = [
      "The Act entered into force in August 2024 [2](https://eur-lex.europa.eu/eli/reg/2024/1689/oj).",
      "Bans apply from February 2025 [1](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai/) and [2](https://eur-lex.europa.eu/eli/reg/2024/1689/oj#art5).",
      'Coverage was wide [3](<https://www.bbc.com/news/1>), see [the text](https://eur-lex.europa.eu/x) and [4](https://example.com/untitled "Untitled").',
      "Ignored: `[9](https://code.test)` and [x](https://not-a-number.test).",
    ].join("\n");
    expect(collectSources(answer, seen)).toEqual([
      {
        n: 2,
        url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
        title: "Regulation (EU) 2024/1689",
        kind: "web",
      },
      {
        n: 1,
        url: "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai/",
        title: "AI Act | Shaping Europe's digital future",
        kind: "web",
      },
      { n: 3, url: "https://www.bbc.com/news/1", title: "BBC News", kind: "web" },
      { n: 4, url: "https://example.com/untitled", title: "example.com", kind: "web" },
    ]);
  });

  it("keeps parentheses inside a URL", () => {
    const sources = collectSources(
      "See [1](https://en.wikipedia.org/wiki/Mercury_(planet)).",
      seen,
    );
    expect(sources.map((s) => s.url)).toEqual(["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
    expect(sources[0]?.title).toBe("en.wikipedia.org");
  });

  it("knows a link to one of Sling's documents, with its page", () => {
    const answer =
      "No pets [1](https://sling.test/api/sources/src_lease/view?page=4), unless agreed [2](https://sling.test/api/sources/src_other/view).";
    expect(collectSources(answer, seen, "https://sling.test")).toEqual([
      {
        n: 1,
        url: "https://sling.test/api/sources/src_lease/view?page=4",
        title: "lease.pdf",
        kind: "document",
        sourceId: "src_lease",
        page: 4,
      },
      {
        n: 2,
        url: "https://sling.test/api/sources/src_other/view",
        title: "Document",
        kind: "document",
        sourceId: "src_other",
      },
    ]);
    // Another site's path that looks the same is a web page.
    expect(
      collectSources(
        "[1](https://evil.test/api/sources/src_lease/view?page=4)",
        seen,
        "https://sling.test",
      )[0]?.kind,
    ).toBe("web");
  });

  it("has none when nothing is cited", () => {
    expect(collectSources("Rust 1.99 is out. Source: https://blog.rust-lang.org/", seen)).toEqual(
      [],
    );
  });

  it("names a site without www", () => {
    expect(siteName("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(siteName("not a url")).toBe("not a url");
  });
});
