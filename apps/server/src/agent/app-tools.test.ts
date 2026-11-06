import { PERMISSION_MODES, sendPolicy } from "@sling/core";
import { connector as calendar } from "@sling/integration-calendar";
import { createDiscordConnector } from "@sling/integration-discord";
import { connector as email } from "@sling/integration-email";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeRegistry } from "../workflows/registry.ts";
import type { AnyServerNodeSpec } from "../workflows/types.ts";
import { argumentPlan, fillSummary, toolName, versionSends } from "./app-tools.ts";

const spec = (type: string): AnyServerNodeSpec => {
  const all = [
    ...email.nodes,
    ...calendar.nodes,
    ...createDiscordConnector({
      rest: () => ({ request: async () => ({ status: 200, body: {} }) }),
    }).nodes,
  ];
  const s = all.find((n) => n.type === type);
  if (!s) throw new Error(`no ${type}`);
  return s as AnyServerNodeSpec;
};

describe("tools from flagged nodes", () => {
  it("names a tool after its node type", () => {
    expect(toolName("calendar.list_events")).toBe("calendar_list_events");
    expect(toolName("email.send")).toBe("email_send");
    expect(toolName("acme-crm.contacts.create")).toBe("acme-crm_contacts_create");
  });

  it("takes the config fields and input ports, without the installation field", () => {
    const plan = argumentPlan(spec("email.send"), ["Inbox"]);
    const props = plan.json.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(["inReplyTo", "subject", "text", "to"]);
    expect(plan.json.required).toEqual(["to"]);
    expect(plan.json.additionalProperties).toBe(false);
    // The text port and the text setting are one argument, given to both.
    expect([...plan.inputKeys]).toEqual(["text"]);
    expect(plan.configKeys.has("text")).toBe(true);
    // Editor hints and expression examples aren't for the model.
    expect(props.text?.widget).toBeUndefined();
    expect(props.inReplyTo?.description).toBe(
      "Message-ID of the email this answers, so mail apps thread the reply.",
    );
  });

  it("adds an installation choice only when there's more than one", () => {
    const one = argumentPlan(spec("calendar.list_events"), ["Home"]);
    expect((one.json.properties as object) ?? {}).not.toHaveProperty("installation");
    const two = argumentPlan(spec("calendar.list_events"), ["Home", "Work"]);
    expect((two.json.properties as Record<string, unknown>).installation).toEqual({
      type: "string",
      enum: ["Home", "Work"],
      description: "Which of the user's accounts to use.",
    });
    expect(two.json.required).toEqual(["installation"]);
    const zod = z.fromJSONSchema(two.json as Parameters<typeof z.fromJSONSchema>[0]);
    expect(zod.safeParse({ installation: "Work", from: "tomorrow" }).success).toBe(true);
    expect(zod.safeParse({ installation: "Elsewhere" }).success).toBe(false);
    expect(zod.safeParse({ installation: "Home", sneaky: 1 }).success).toBe(false);
  });

  it("leaves out ports a chat can't fill, such as an approval from another node", () => {
    const plan = argumentPlan(spec("discord.send_message"), ["Bot"]);
    const props = Object.keys(plan.json.properties as object);
    expect(props).toContain("content");
    expect(props).not.toContain("approval");
    expect(plan.inputKeys.has("approval")).toBe(false);
  });

  it("fills the summary from the call's values", () => {
    expect(
      fillSummary("Email {to}: {subject}", { to: "ana@example.com", subject: "Lunch moved" }, "x"),
    ).toBe("Email ana@example.com: Lunch moved");
    expect(fillSummary("Add {title} to the calendar at {start}", { title: "Dentist" }, "x")).toBe(
      "Add Dentist to the calendar at",
    );
    expect(fillSummary("To {to}", { to: ["a@x", "b@x"] }, "x")).toBe("To a@x, b@x");
    const long = fillSummary("Post {content}", { content: `line one\n${"word ".repeat(40)}` }, "x");
    expect(long).toHaveLength(85);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("\n");
    expect(fillSummary(undefined, {}, "Send Discord message")).toBe("Send Discord message");
  });
});

describe("what asks first", () => {
  it("refuses sends in Read-only, asks in Supervised and Auto, and runs them in Full access", () => {
    expect(Object.fromEntries(PERMISSION_MODES.map((m) => [m, sendPolicy(m)]))).toEqual({
      "read-only": "refuse",
      supervised: "ask",
      auto: "ask",
      "full-access": "run",
    });
  });

  it("counts a workflow as sending when a node can't be repeated or is flagged as sending", () => {
    const registry = new NodeRegistry();
    registry.registerConnector(email);
    registry.registerConnector(calendar);
    registry.register({
      type: "test.get",
      version: 1,
      title: "Get",
      description: "",
      category: "action",
      configSchema: z.object({ method: z.string() }),
      inputs: [],
      outputs: [],
      execInput: true,
      execOutputs: [{ name: "next" }],
      idempotent: false,
      idempotentWhen: (c: Record<string, unknown>) => c.method === "GET",
      run: async () => ({ exec: "next" }),
    } as AnyServerNodeSpec);
    const node = (type: string, config: Record<string, unknown> = {}) => ({
      type,
      version: 1,
      config,
    });
    const ctx = { registry };
    expect(versionSends(ctx, [node("calendar.list_events")])).toBe(false);
    expect(versionSends(ctx, [node("calendar.list_events"), node("email.send")])).toBe(true);
    // Safe to repeat, but it still adds an event.
    expect(versionSends(ctx, [node("calendar.create_event")])).toBe(true);
    expect(versionSends(ctx, [node("test.get", { method: "GET" })])).toBe(false);
    expect(versionSends(ctx, [node("test.get", { method: "POST" })])).toBe(true);
    expect(versionSends(ctx, [node("nobody.knows")])).toBe(true);
  });
});
