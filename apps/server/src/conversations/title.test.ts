import { describe, expect, it } from "vitest";
import { chatTitle } from "./title.ts";

describe("a chat's title from its first message", () => {
  it("is the whole message when it fits, on one line", () => {
    expect(chatTitle("  Fix the\nfooter  ")).toBe("Fix the footer");
  });

  it("cuts a long message at a word", () => {
    const title = chatTitle(
      "Make it dynamic so the footer year changes by itself every January, and add a test",
    );
    expect(title).toBe("Make it dynamic so the footer year changes by itself every…");
    expect(Array.from(title).length).toBeLessThanOrEqual(60);
  });

  it("cuts a message with no spaces where it has to", () => {
    expect(chatTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
  });
});
