import { describe, expect, it } from "vitest";
import {
  type AnswerClaims,
  answerableSteps,
  answerKey,
  answerToken,
  NotificationAnswerSchema,
  readAnswerToken,
} from "./answers.ts";
import { encodePayload } from "./payloads.ts";

const key = answerKey("answers-unit-secret-key-that-is-long-enough");
const claims: AnswerClaims = {
  workspaceId: "wsp_1",
  userId: "usr_1",
  expiresAt: Date.UTC(2026, 10, 7, 12, 0),
};

describe("answer tokens", () => {
  it("reads back what it was made with, for the same approval", () => {
    const token = answerToken(key, "apv_1", claims);
    expect(readAnswerToken(key, "apv_1", token)).toEqual(claims);
    const chat = { ...claims, conversationId: "cnv_1" };
    expect(readAnswerToken(key, "cap_1", answerToken(key, "cap_1", chat))).toEqual(chat);
  });

  it("leaves expiry to the caller, so an old token still says when it expired", () => {
    const old = { ...claims, expiresAt: 1 };
    expect(readAnswerToken(key, "apv_1", answerToken(key, "apv_1", old))?.expiresAt).toBe(1);
  });

  it("refuses another approval's token", () => {
    expect(readAnswerToken(key, "apv_2", answerToken(key, "apv_1", claims))).toBeNull();
  });

  it("refuses a token made with another secret", () => {
    const other = answerKey("another-secret-key-that-is-long-enough!!");
    expect(readAnswerToken(key, "apv_1", answerToken(other, "apv_1", claims))).toBeNull();
  });

  it("refuses a token whose claims or signature were changed", () => {
    const token = answerToken(key, "apv_1", claims);
    const [body = "", sig = ""] = token.split(".");
    // A later expiry, or someone else, with the old signature.
    for (const forged of [
      { ...claims, expiresAt: claims.expiresAt + 86_400_000 },
      { ...claims, userId: "usr_2" },
      { ...claims, conversationId: "cnv_1" },
    ]) {
      const swapped = answerToken(key, "apv_1", forged).split(".")[0];
      expect(readAnswerToken(key, "apv_1", `${swapped}.${sig}`)).toBeNull();
    }
    const flip = (s: string) => (s[0] === "A" ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    expect(readAnswerToken(key, "apv_1", `${body}.${flip(sig)}`)).toBeNull();
    expect(readAnswerToken(key, "apv_1", `${flip(body)}.${sig}`)).toBeNull();
    expect(readAnswerToken(key, "apv_1", `${body}.${sig.slice(0, -1)}`)).toBeNull();
  });

  it("refuses tokens that aren't one", () => {
    for (const t of ["", ".", "abc", ".abc", "abc.", "a.b.c"]) {
      expect(readAnswerToken(key, "apv_1", t)).toBeNull();
    }
  });

  it("refuses signed claims of the wrong shape", async () => {
    const { createHmac } = await import("node:crypto");
    const body = Buffer.from(JSON.stringify({ w: "wsp_1", u: 7, e: "soon" })).toString("base64url");
    const sig = createHmac("sha256", key).update(`apv_1\n${body}`).digest("base64url");
    expect(readAnswerToken(key, "apv_1", `${body}.${sig}`)).toBeNull();
  });

  it("is short enough for a push", () => {
    const token = answerToken(key, "cap_0123456789abcdef01234567", {
      workspaceId: "wsp_01JC0000000000000000000000",
      userId: "Xw8Rz0B9q4c2YyN1mVvT3kLpQs6uJh5e",
      expiresAt: Date.now(),
      conversationId: "cnv_01JC0000000000000000000000",
    });
    expect(token.length).toBeLessThan(250);
    expect(NotificationAnswerSchema.safeParse({ token, answer: "allow" }).success).toBe(true);
  });
});

describe("which task steps a notification answers", () => {
  it("answers pushes and PRs, never a merge or a deploy", () => {
    expect(answerableSteps(["push"])).toBe(true);
    expect(answerableSteps(["push", "open_pr"])).toBe(true);
    expect(answerableSteps(["open_pr"])).toBe(true);
    expect(answerableSteps(["merge"])).toBe(false);
    expect(answerableSteps(["merge", "deploy"])).toBe(false);
    expect(answerableSteps(["open_pr", "deploy"])).toBe(false);
    expect(answerableSteps([])).toBe(false);
  });
});

describe("the payload", () => {
  it("carries the answer, and nothing else it was handed", () => {
    const answer = { approvalId: "apv_1", token: answerToken(key, "apv_1", claims) };
    const json = JSON.parse(
      encodePayload({
        title: "Approve pull request?",
        body: "Fix the footer",
        url: "/approvals",
        tag: "task:tsk_1",
        answer: { ...answer, extra: "no" } as typeof answer,
      }).toString(),
    );
    expect(json.answer).toEqual(answer);
    const plain = JSON.parse(
      encodePayload({ title: "t", body: "b", url: "/", tag: "x" }).toString(),
    );
    expect(plain).not.toHaveProperty("answer");
  });
});
