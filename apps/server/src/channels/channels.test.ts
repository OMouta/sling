import type { TriggerEvent } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.ts";
import { channelConnectors } from "./connectors.ts";
import type { ChannelMessageView } from "./service.ts";
import { plainText } from "./text.ts";

describe("plainText", () => {
  it("drops Markdown marks and keeps the words", () => {
    expect(
      plainText(
        [
          "## Today",
          "",
          "- **Dinner** with *Jo* at 20:00",
          "* [x] Book the _table_",
          "> See [the menu](https://example.com/menu) or <https://example.com>",
          "",
          "---",
          "",
          "",
          "Use `npm run build`, not ~~make~~.",
          "![map](https://example.com/map.png)",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Today",
        "",
        "• Dinner with Jo at 20:00",
        "• Book the table",
        "See the menu (https://example.com/menu) or https://example.com",
        "",
        "Use npm run build, not make.",
        "map (https://example.com/map.png)",
      ].join("\n"),
    );
  });

  it("leaves code, snake_case, and lone stars as they are", () => {
    expect(plainText("```\nconst a = **b**;\n```")).toBe("const a = **b**;");
    expect(plainText("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
    expect(plainText("`*not* emphasis`")).toBe("*not* emphasis");
    expect(plainText("[https://x.io](https://x.io)")).toBe("https://x.io");
    expect(plainText("  \n\n ")).toBe("");
  });
});

describe("channel triggers", () => {
  const [imessage, signal] = channelConnectors({} as AppContext);
  const trigger = (c: typeof imessage) =>
    c?.nodes.find((n) => n.trigger)?.trigger as NonNullable<
      NonNullable<typeof imessage>["nodes"][number]["trigger"]
    >;
  const message: ChannelMessageView = {
    id: "41",
    conversation: "+351912345678",
    sender: "+351912345678",
    text: "book dinner",
    isGroup: false,
    sentAt: "2026-11-07T10:00:00.000Z",
  };
  const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
    type: "imessage.message_received",
    workspaceId: "w",
    installationId: "ins_1",
    payload: message,
    at: new Date(),
    ...over,
  });

  it("matches its own installation's messages, one conversation at a time", async () => {
    const t = trigger(imessage);
    expect(await t.match(event(), { installationId: "ins_1" })).toEqual({
      outputs: { message },
      concurrencyKey: "imessage:ins_1:+351912345678",
    });
    expect(await t.match(event({ installationId: "ins_2" }), { installationId: "ins_1" })).toBe(
      null,
    );
    expect(
      await t.match(event({ type: "signal.message_received" }), { installationId: "ins_1" }),
    ).toBe(null);
    expect(trigger(signal).event).toBe("signal.message_received");
  });

  it("takes only the senders it names, when it names some", async () => {
    const t = trigger(imessage);
    expect(
      await t.match(event(), { installationId: "ins_1", senders: ["+351912345678"] }),
    ).not.toBe(null);
    expect(await t.match(event(), { installationId: "ins_1", senders: ["jo@icloud.com"] })).toBe(
      null,
    );
  });

  it("sends as the assistant only with the user's say, and lets a rule pin who to", () => {
    const send = imessage?.nodes.find((n) => n.type === "imessage.send_message");
    expect(send?.assistant).toEqual({
      sends: true,
      summary: "iMessage to {conversation}: {text}",
      ruleFields: ["conversation"],
    });
    expect(send?.verify).toBeTypeOf("function");
    expect(imessage?.secretFields).toEqual([]);
  });
});
