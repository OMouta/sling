import { describe, expect, it } from "vitest";
import { anthropicMeta, openaiLabel, openaiMeta } from "./catalog.ts";
import { providerOptionsFor } from "./models.ts";

describe("assistant provider options", () => {
  it("sends Anthropic effort and fast mode", () => {
    expect(
      providerOptionsFor({
        provider: "anthropic",
        model: "claude-opus-5-5",
        effort: "xhigh",
        fast: true,
      }),
    ).toEqual({ anthropic: { effort: "xhigh", speed: "fast" } });
  });

  it("sends OpenAI reasoning effort and the priority tier", () => {
    expect(
      providerOptionsFor({ provider: "openai", model: "gpt-5.1", effort: "high", fast: true }),
    ).toEqual({ openai: { reasoningEffort: "high", serviceTier: "priority" } });
  });

  it("leaves defaults to the provider", () => {
    expect(
      providerOptionsFor({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        effort: null,
        fast: false,
      }),
    ).toEqual({ anthropic: {} });
    expect(
      providerOptionsFor({
        provider: "openai-compatible",
        model: "llama3.3",
        effort: "high",
        fast: true,
      }),
    ).toEqual({});
  });
});

describe("model metadata", () => {
  it("knows which Claude models take which effort levels, and which have fast mode", () => {
    expect(anthropicMeta("claude-opus-5-5")).toEqual({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      fast: true,
    });
    expect(anthropicMeta("claude-sonnet-5-5")).toMatchObject({
      defaultEffort: "high",
      fast: false,
    });
    expect(anthropicMeta("claude-sonnet-4-6").efforts).toEqual(["low", "medium", "high", "max"]);
    expect(anthropicMeta("claude-haiku-4-5")).toEqual({
      efforts: [],
      defaultEffort: null,
      fast: false,
    });
  });

  it("gives OpenAI reasoning models efforts and plain models none", () => {
    expect(openaiMeta("gpt-5.1").efforts).toEqual(["low", "medium", "high"]);
    expect(openaiMeta("gpt-4.1")).toEqual({ efforts: [], defaultEffort: null, fast: false });
    expect(openaiLabel("gpt-5.1-mini")).toBe("GPT-5.1-mini");
  });
});
