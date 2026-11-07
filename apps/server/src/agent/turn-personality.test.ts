import type { schema } from "@sling/db";
import { describe, expect, it } from "vitest";
import type { PersonalityRow } from "../personalities/service.ts";
import { cliTranscript } from "./agent.ts";
import { turnSession } from "./turn-personality.ts";

type MessageRow = typeof schema.messages.$inferSelect;

const p = (id: string) => ({ id }) as PersonalityRow;
const session = (personalityId?: string | null) => ({
  harness: "claude-code" as const,
  runnerId: "run_1",
  sessionId: "ses_1",
  ...(personalityId !== undefined ? { personalityId } : {}),
});

describe("turnSession", () => {
  it("resumes a session that answered as this turn's personality", () => {
    const s = session("prs_sling");
    expect(turnSession(s, { row: p("prs_sling"), own: p("prs_sling") })).toBe(s);
  });

  it("starts a new one for a mention, and for the turn after it", () => {
    expect(
      turnSession(session("prs_sling"), { row: p("prs_writer"), own: p("prs_sling") }),
    ).toBeNull();
    expect(
      turnSession(session("prs_writer"), { row: p("prs_sling"), own: p("prs_sling") }),
    ).toBeNull();
  });

  it("takes a session from before mentions as the chat's own", () => {
    const s = session();
    expect(turnSession(s, { row: p("prs_sling"), own: p("prs_sling") })).toBe(s);
    expect(turnSession(s, { row: p("prs_writer"), own: p("prs_sling") })).toBeNull();
  });

  it("has nothing to resume without a session", () => {
    expect(turnSession(null, { row: p("prs_sling"), own: p("prs_sling") })).toBeNull();
  });
});

describe("cliTranscript", () => {
  let n = 0;
  const msg = (role: MessageRow["role"], text: string) =>
    ({ id: `msg_${++n}`, role, content: { role, content: text } }) as unknown as MessageRow;

  it("labels replies by personality when given labels", () => {
    const rows = [
      msg("user", "Plan my week."),
      msg("assistant", "Monday: gym."),
      msg("user", "@Writer make it a poem"),
      msg("assistant", "Monday, the gym awaits."),
      msg("user", "Thanks"),
    ];
    const labels = new Map([
      [rows[1]?.id ?? "", "Sling"],
      [rows[3]?.id ?? "", "Writer"],
    ]);
    const { prompt, history } = cliTranscript(rows, labels);
    expect(prompt).toBe("Thanks");
    expect(history).toBe(
      "The conversation so far:\n\nUser: Plan my week.\n\nSling: Monday: gym.\n\nUser: @Writer make it a poem\n\nWriter: Monday, the gym awaits.",
    );
    expect(cliTranscript(rows).history).toContain("Assistant: Monday: gym.");
  });
});
