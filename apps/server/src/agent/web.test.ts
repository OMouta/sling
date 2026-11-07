import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ServerEvent, ToolStep } from "@sling/core";
import { streamText, type ToolSet } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { webTools } from "./models.ts";
import { TraceRecorder } from "./trace.ts";
import {
  cliToolFinished,
  cliToolStarted,
  ProviderWebSteps,
  searchesWeb,
  wantsResearch,
} from "./web.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** Runs one model step that streams `parts`, through the same loop an API turn uses. */
async function turn(parts: LanguageModelV4StreamPart[], tools: ToolSet) {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: "stream-start", warnings: [] },
        ...parts,
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ]),
    }),
  });
  const events: ServerEvent[] = [];
  const trace = new TraceRecorder("cnv_1", (ev) => events.push(ev));
  const web = new ProviderWebSteps(trace);
  const result = streamText({ model, prompt: "What changed?", tools });
  for await (const part of result.fullStream) {
    if (web.handle(part)) continue;
    if (part.type === "text-delta") trace.text(part.text);
    if (part.type === "tool-call") trace.toolStarted(part.toolCallId, part.toolName, part.input);
  }
  const done = trace.finish("");
  const steps = (done.trace?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool");
  return { ...done, steps, events, model };
}

const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "a" },
  { type: "text-delta", id: "a", delta: t },
  { type: "text-end", id: "a" },
];

describe("a provider's own web search", () => {
  it("records Anthropic's searches and page reads as web steps, and titles its citations", async () => {
    const { answer, steps, trace, events, model } = await turn(
      [
        {
          type: "tool-call",
          toolCallId: "srv_1",
          toolName: "web_search",
          input: JSON.stringify({ query: "rust release" }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "srv_1",
          toolName: "web_search",
          result: [
            {
              type: "web_search_result",
              url: "https://blog.rust-lang.org/releases/",
              title: "Rust Releases",
              pageAge: null,
              encryptedContent: "x",
            },
          ],
        },
        {
          type: "source",
          sourceType: "url",
          id: "s1",
          url: "https://releases.rs/",
          title: "Rust Versions",
        },
        {
          type: "tool-call",
          toolCallId: "srv_2",
          toolName: "web_fetch",
          input: JSON.stringify({ url: "https://releases.rs/" }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "srv_2",
          toolName: "web_fetch",
          result: {
            type: "web_fetch_result",
            url: "https://releases.rs/",
            retrievedAt: null,
            content: {
              type: "document",
              title: "Rust Versions | Rust Changelogs",
              source: {
                type: "text",
                mediaType: "text/plain",
                data: "Stable: 1.99.1 ".repeat(500),
              },
            },
          },
        },
        ...text(
          "Rust 1.99.1 is stable [1](https://releases.rs/), see [2](https://blog.rust-lang.org/releases/).",
        ),
      ],
      webTools("anthropic"),
    );
    const sent = model.doStreamCalls[0]?.tools?.map((t) => (t.type === "provider" ? t.id : t.name));
    expect(sent).toEqual(["anthropic.web_search_20250305", "anthropic.web_fetch_20250910"]);
    expect(steps.map((s) => [s.name, s.input, s.status])).toEqual([
      ["web_search", { query: "rust release" }, "done"],
      ["web_fetch", { url: "https://releases.rs/" }, "done"],
    ]);
    expect(JSON.parse(steps[0]?.output ?? "")).toEqual({
      results: [{ title: "Rust Releases", url: "https://blog.rust-lang.org/releases/" }],
    });
    const page = JSON.parse(steps[1]?.output ?? "");
    expect(page.title).toBe("Rust Versions | Rust Changelogs");
    expect(page.text.length).toBeLessThanOrEqual(2_001);
    expect(answer).toContain("[1](https://releases.rs/)");
    expect(trace?.sources).toEqual([
      { n: 1, url: "https://releases.rs/", title: "Rust Versions | Rust Changelogs", kind: "web" },
      { n: 2, url: "https://blog.rust-lang.org/releases/", title: "Rust Releases", kind: "web" },
    ]);
    // The search showed live, before its result.
    const live = events.filter((e) => e.type === "agent.tool").map((e) => e.step.status);
    expect(live.slice(0, 2)).toEqual(["running", "done"]);
  });

  it("records OpenAI's, whose calls say what they did only in their result", async () => {
    const { steps, trace } = await turn(
      [
        {
          type: "tool-call",
          toolCallId: "ws_1",
          toolName: "web_search",
          input: "{}",
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "ws_1",
          toolName: "web_search",
          result: {
            action: { type: "search", query: "eu ai act" },
            sources: [{ type: "url", url: "https://artificialintelligenceact.eu/" }],
          },
        },
        {
          type: "source",
          sourceType: "url",
          id: "s1",
          url: "https://artificialintelligenceact.eu/",
        },
        {
          type: "tool-call",
          toolCallId: "ws_2",
          toolName: "web_search",
          input: "{}",
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "ws_2",
          toolName: "web_search",
          result: { action: { type: "openPage", url: "https://eur-lex.europa.eu/x" } },
        },
        {
          type: "tool-call",
          toolCallId: "ws_3",
          toolName: "web_search",
          input: "{}",
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "ws_3",
          toolName: "web_search",
          result: { status: "failed" },
          isError: true,
        },
        ...text("Bans apply from 2025 [1](https://artificialintelligenceact.eu/)."),
      ],
      webTools("openai"),
    );
    expect(steps.map((s) => [s.name, s.input, s.status])).toEqual([
      ["web_search", { query: "eu ai act" }, "done"],
      ["web_fetch", { url: "https://eur-lex.europa.eu/x" }, "done"],
      ["web_search", { query: "" }, "error"],
    ]);
    expect(JSON.parse(steps[0]?.output ?? "")).toEqual({
      results: [{ title: "", url: "https://artificialintelligenceact.eu/" }],
    });
    expect(trace?.sources).toEqual([
      {
        n: 1,
        url: "https://artificialintelligenceact.eu/",
        title: "artificialintelligenceact.eu",
        kind: "web",
      },
    ]);
  });

  it("gives OpenAI-compatible servers no search", () => {
    expect(webTools("openai-compatible")).toEqual({});
    expect(Object.keys(webTools("openai"))).toEqual(["web_search"]);
  });
});

describe("a CLI's web steps", () => {
  it("records them from the Runner's events, cutting a page's text", () => {
    const trace = new TraceRecorder("cnv_1", () => {});
    cliToolStarted(trace, { id: "t1", name: "web_search", inputJson: '{"query":"rust"}' });
    cliToolFinished(trace, {
      id: "t1",
      output: '{"results":[{"title":"Rust","url":"https://rust-lang.org/"}]}',
      error: false,
    });
    cliToolStarted(trace, {
      id: "t2",
      name: "web_fetch",
      inputJson: '{"url":"https://rust-lang.org/"}',
    });
    cliToolFinished(trace, {
      id: "t2",
      output: JSON.stringify({ text: "x".repeat(5_000) }),
      error: false,
    });
    cliToolStarted(trace, {
      id: "t3",
      name: "web_fetch",
      inputJson: '{"url":"https://gone.test/"}',
    });
    cliToolFinished(trace, {
      id: "t3",
      output: "Request failed with status code 404",
      error: true,
    });
    trace.text("Rust is fast [1](https://rust-lang.org/).");
    const { trace: saved } = trace.finish("");
    const steps = (saved?.steps ?? []) as ToolStep[];
    expect(steps.map((s) => [s.name, s.input, s.status])).toEqual([
      ["web_search", { query: "rust" }, "done"],
      ["web_fetch", { url: "https://rust-lang.org/" }, "done"],
      ["web_fetch", { url: "https://gone.test/" }, "error"],
    ]);
    expect(JSON.parse(steps[1]?.output ?? "").text).toHaveLength(2_001);
    expect(steps[2]?.output).toBe("Request failed with status code 404");
    expect(saved?.sources).toEqual([
      { n: 1, url: "https://rust-lang.org/", title: "Rust", kind: "web" },
    ]);
  });
});

describe("which turns search", () => {
  it("needs the web on the personality and a model that searches", () => {
    const anthropic = { provider: "anthropic" as const };
    expect(searchesWeb(["memory", "web"], anthropic)).toBe(true);
    expect(searchesWeb(["web"], { provider: "claude-code" })).toBe(true);
    expect(searchesWeb(["memory"], anthropic)).toBe(false);
    expect(searchesWeb(["web"], { provider: "openai-compatible" })).toBe(false);
    expect(searchesWeb(["web"], null)).toBe(false);
  });

  it("runs Deep research only for the message being answered", () => {
    const research = { role: "user", meta: { research: true } };
    expect(wantsResearch([research])).toBe(true);
    expect(wantsResearch([research, { role: "system", meta: null }])).toBe(true);
    expect(wantsResearch([research, { role: "assistant" }, { role: "system" }])).toBe(false);
    expect(wantsResearch([{ role: "user", meta: null }])).toBe(false);
  });
});
