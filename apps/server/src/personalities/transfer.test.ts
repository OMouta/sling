import { describe, expect, it } from "vitest";
import { readPersonalityFile } from "./transfer.ts";

const tutor = {
  format: "sling.personality/v1",
  name: "Tutor",
  description: "Statistics, step by step.",
  instructions: "You are Tutor.",
  tools: ["memory", "web"],
  color: "teal",
  shape: "bloom",
  assistant: { provider: "claude-code", model: "claude-haiku-5-5", effort: null, fast: false },
  sources: [
    { kind: "file", name: "lecture-2.pdf", mediaType: "application/pdf", data: "JVBERi0xLjQ=" },
    { kind: "link", name: "Course page", url: "https://example.edu/stats" },
  ],
};

const bytes = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));

describe("readPersonalityFile", () => {
  it("reads an exported file from its bytes", () => {
    const read = readPersonalityFile(bytes(tutor));
    expect(read).toEqual({ ok: true, file: tutor });
  });

  it("drops tool groups this Sling doesn't know", () => {
    const read = readPersonalityFile(bytes({ ...tutor, tools: ["web", "teleport", "memory"] }));
    expect(read.ok && read.file.tools).toEqual(["memory", "web"]);
  });

  it("fills in what an older file leaves out", () => {
    const { assistant: _, sources: __, description: ___, ...bare } = tutor;
    const read = readPersonalityFile(bytes(bare));
    expect(read.ok && read.file).toMatchObject({ description: "", assistant: null, sources: [] });
  });

  it("refuses a file that isn't one, with a reason", () => {
    for (const body of [bytes("not json"), bytes({ name: "Tutor" }), bytes([1, 2]), null]) {
      expect(readPersonalityFile(body)).toEqual({
        ok: false,
        error: "This file isn't a Sling personality.",
      });
    }
    expect(readPersonalityFile(bytes({ ...tutor, format: "sling.personality/v2" }))).toEqual({
      ok: false,
      error: "This personality file is from a newer Sling. Update Sling first.",
    });
  });

  it("says which field is wrong", () => {
    const long = readPersonalityFile(bytes({ ...tutor, name: "x".repeat(41) }));
    expect(long.ok).toBe(false);
    expect(!long.ok && long.error).toMatch(/^This personality file has a problem: name: /);
    const data = readPersonalityFile(
      bytes({ ...tutor, sources: [{ ...tutor.sources[0], data: "not base64!" }] }),
    );
    expect(!data.ok && data.error).toMatch(/sources\.0\.data/);
    const link = readPersonalityFile(
      bytes({ ...tutor, sources: [{ kind: "link", name: "x", url: "file:///etc/passwd" }] }),
    );
    expect(!link.ok && link.error).toMatch(/sources\.0\.url/);
  });
});
