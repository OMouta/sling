import { describe, expect, it } from "vitest";
import { requestLog, safeRequestUrl } from "./logging.ts";

describe("request log credentials", () => {
  it("removes bearer path tokens and all query values", () => {
    expect(safeRequestUrl("/hooks/secret?token=other")).toBe("/hooks/[REDACTED]?[REDACTED]");
    expect(safeRequestUrl("/api/oauth/callback?code=secret&state=secret")).toBe(
      "/api/oauth/callback?[REDACTED]",
    );
    expect(safeRequestUrl("/api/tasks")).toBe("/api/tasks");
  });
  it("does not serialize request headers or arbitrary properties", () => {
    const request = { method: "POST", url: "/hooks/secret", headers: { authorization: "secret" } };
    expect(JSON.stringify(requestLog(request))).not.toContain("secret");
  });
});
