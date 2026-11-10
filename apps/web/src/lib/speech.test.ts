import { afterEach, describe, expect, it, vi } from "vitest";
import { liveText } from "./followUps.ts";
import { speak, speakableText, speechPieces, stopSpeaking } from "./speech.ts";

describe("reading a reply aloud", () => {
  it("leaves out code blocks, link addresses, and citation numbers", () => {
    const reply = [
      "## Steps",
      "",
      "1. Run **the** `build` [script](https://example.com/a) [1](https://example.com/a).",
      "- See <https://example.com> or https://example.com/b [2](https://x.y)",
      "",
      "```sh",
      "pnpm build",
      "```",
      "",
      "> _Done_ ~~soon~~.",
    ].join("\n");
    expect(speakableText(reply)).toBe("Steps\n\nRun the build script.\nSee or\n\nDone soon.");
  });

  it("reads a table's cells and skips its divider", () => {
    expect(speakableText("| Repo | Branch |\n|---|---|\n| site | main |")).toBe(
      "Repo, Branch\nsite, main",
    );
  });

  it("keeps snake_case and a lone asterisk", () => {
    expect(speakableText("Set max_retries to 3 * 2.")).toBe("Set max_retries to 3 * 2.");
  });

  it("splits long text at sentence ends into pieces a browser speaks whole", () => {
    const text = `${"One two three. ".repeat(30)}Last.`;
    const pieces = speechPieces(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(220);
    expect(pieces.join(" ")).toBe(text.trim());
  });
});

describe("the voice a reply is read in", () => {
  afterEach(() => {
    stopSpeaking();
    vi.unstubAllGlobals();
  });

  it("speaks the user's language, not the page's", () => {
    const spoken: { text: string; lang: string }[] = [];
    vi.stubGlobal("navigator", { language: "pt-PT" });
    vi.stubGlobal("window", {
      speechSynthesis: {
        cancel() {},
        speak: (u: { text: string; lang: string }) => spoken.push(u),
      },
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        lang = "";
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    speak("msg_1", "Olá. Está tudo pronto.");
    expect(spoken.map((u) => u.lang)).toEqual(["pt-PT"]);
  });
});

describe("a reply as it streams", () => {
  it("hides its follow-ups, even a tag cut off at the end", () => {
    expect(liveText("Done.\n<follow-ups>\nNext")).toBe("Done.\n");
    expect(liveText("Done.\n<foll")).toBe("Done.\n");
    expect(liveText("a < b")).toBe("a < b");
  });
});
