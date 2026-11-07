import { connector as calendar } from "@sling/integration-calendar";
import { connector as discord } from "@sling/integration-discord";
import { connector as email } from "@sling/integration-email";
import { connector as telegram } from "@sling/integration-telegram";
import { WORKFLOW_SCHEMA, type WorkflowDefinition } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { registerCoreNodes } from "./nodes/index.ts";
import { NodeRegistry } from "./registry.ts";
import { cronText, type StepNames, settingText, workflowSteps } from "./summary.ts";
import { applyBindings, loadTemplates, TEMPLATES_DIR } from "./templates.ts";

const registry = new NodeRegistry();
registerCoreNodes(registry);
for (const c of [calendar, discord, email, telegram]) registry.registerConnector(c);

const NOW = new Date("2026-11-07T12:00:00Z");
const GENERAL = "222222222222222222";

const accounts: Record<string, { name: string; config: Record<string, unknown> }> = {
  ins_discord: { name: "Sling bot", config: { defaultChannelId: GENERAL } },
  ins_email: { name: "ana@example.com", config: {} },
  ins_calendar: { name: "Personal", config: {} },
  ins_telegram: { name: "@sling_home_bot", config: {} },
};

const names: StepNames = {
  installation: (id) => accounts[id],
  option: (id, value) => (id === "ins_discord" && value === GENERAL ? "#general" : undefined),
};

const lines = (def: WorkflowDefinition, n: StepNames = names) =>
  workflowSteps(def, registry, n, NOW).map((s) => (s.sends ? `${s.text} [sends]` : s.text));

describe("a workflow's steps in words", () => {
  const templates = loadTemplates(TEMPLATES_DIR, (key, err) => {
    throw new Error(`${key}: ${err}`);
  });
  const bound = (key: string) => {
    const t = templates.find((x) => x.view.key === key);
    if (!t) throw new Error(`no template ${key}`);
    return applyBindings(t.definition, {
      $discord: "ins_discord",
      $email: "ins_email",
      $calendar: "ins_calendar",
      $telegram: "ins_telegram",
    });
  };

  const expected: Record<string, string[]> = {
    "approval-notifications-discord": [
      "When something needs your approval",
      "Send to Discord #general, with Approve and Reject buttons [sends]",
    ],
    "discord-assistant": [
      "When someone sends Sling bot a direct message on Discord",
      "Or when a task from its chat finishes or needs you",
      "Find or start its chat",
      "Ask the assistant",
      "Send a Discord message [sends]",
    ],
    "important-email-to-discord": [
      "When an email arrives in ana@example.com",
      "From an important sender?",
      "If so: use AI to pull out summary and action items",
      "Send to Discord #general [sends]",
    ],
    "morning-briefing": [
      "Every day at 07:30",
      "Read today's calendar",
      "Find or start its chat",
      "Ask the assistant",
      "Notify your devices: “Your morning briefing”",
    ],
    "site-down-alert": [
      "When a site check changes",
      "Back up?",
      "If so: notify your devices",
      "If not: notify your devices",
    ],
    "sling-assistant": [
      "When you send a message in a chat",
      "Or when a task from its chat finishes or needs you",
      "Find or start its chat",
      "The assistant replies",
    ],
    "telegram-assistant": [
      "When someone messages @sling_home_bot on Telegram",
      "Or when a task from its chat finishes or needs you",
      "Find or start its chat",
      "Ask the assistant",
      "Send a Telegram message [sends]",
    ],
    "website-health-monitor": [
      "Every 5 minutes",
      "Fetch https://example.com",
      "Error status?",
      "If so: send to Discord #general [sends]",
      "If “Check the site” fails: send to Discord #general [sends]",
    ],
  };

  it("covers every built-in template", () => {
    expect(templates.map((t) => t.view.key).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [key, want] of Object.entries(expected)) {
    it(`reads well for ${key}`, () => {
      expect(lines(bound(key))).toEqual(want);
    });
  }

  it("never takes a send's words from its label", () => {
    const def = bound("website-health-monitor");
    const alert = def.nodes.find((n) => n.id === "alert");
    if (alert) alert.label = "Read the calendar";
    expect(lines(def)).toContain("If so: send to Discord #general [sends]");
  });

  it("names the channel by its ID when the account can't be asked", () => {
    expect(
      lines(bound("approval-notifications-discord"), { installation: names.installation }),
    ).toEqual([
      "When something needs your approval",
      `Send to Discord channel ${GENERAL}, with Approve and Reject buttons [sends]`,
    ]);
  });
});

describe("a workflow written in the chat", () => {
  const def = (
    nodes: WorkflowDefinition["nodes"],
    edges: [string, string, string?][],
  ): WorkflowDefinition => ({
    schema: WORKFLOW_SCHEMA,
    name: "From chat",
    description: "",
    nodes,
    edges: edges.map(([from, to, port], i) => ({
      id: `e${i}`,
      kind: "exec" as const,
      from: { node: from, port: port ?? "next" },
      to: { node: to, port: "in" },
    })),
  });
  const n = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    version: 1,
    position: { x: 0, y: 0 },
    config,
  });

  it("reads a weekly calendar sent to Discord", () => {
    expect(
      lines(
        def(
          [
            n("monday", "core.schedule", { cron: "0 9 * * 1" }),
            n("try", "core.manual"),
            n("week", "calendar.list_events", { installationId: "ins_calendar", days: 7 }),
            n("post", "discord.send_message", { installationId: "ins_discord" }),
          ],
          [
            ["monday", "week"],
            ["try", "week"],
            ["week", "post"],
          ],
        ),
      ),
    ).toEqual([
      "Every Monday at 09:00",
      "Or when you run it",
      "Read the next 7 days of the calendar",
      "Send to Discord #general [sends]",
    ]);
  });

  it("reads a reminder, an email, an event, a branch, and a request that sends", () => {
    expect(
      lines(
        def(
          [
            n("at", "core.schedule", { at: "2026-11-07T17:00", timezone: "Europe/Lisbon" }),
            n("push", "app.notify", { title: "Call the bank" }),
            n("ok", "human.approval", { title: "Book the dentist?" }),
            n("event", "calendar.create_event", {
              installationId: "ins_calendar",
              title: "Dentist",
            }),
            n("mail", "email.send", {
              installationId: "ins_email",
              to: "jo@silva.pt",
              subject: "Dentist",
            }),
            n("hook", "http.request", { method: "POST", url: "https://hooks.example/x" }),
            n("pause", "core.wait", { seconds: 600 }),
          ],
          [
            ["at", "push"],
            ["push", "ok"],
            ["ok", "event", "approved"],
            ["event", "mail"],
            ["ok", "pause", "rejected"],
            ["pause", "hook"],
          ],
        ),
      ),
    ).toEqual([
      "Once, on Saturday 7 November at 17:00 (Europe/Lisbon)",
      "Notify your devices: “Call the bank”",
      "Ask you to approve “Book the dentist?”",
      "If you approve: add “Dentist” to Personal [sends]",
      "Email jo@silva.pt: “Dentist” [sends]",
      "If you reject it: wait 10 minutes",
      "POST to https://hooks.example/x [sends]",
    ]);
  });

  it("reads a node type it doesn't know by its title", () => {
    expect(lines(def([n("t", "core.manual"), n("x", "acme.thing")], [["t", "x"]]))).toEqual([
      "When you run it",
      "acme.thing",
    ]);
  });
});

describe("a cron expression in words", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at 15 past"],
    ["0 */2 * * *", "Every 2 hours"],
    ["30 7 * * *", "Every day at 07:30"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["0 9 * * TUE", "Every Tuesday at 09:00"],
    ["0 9 * * 1-5", "Every weekday at 09:00"],
    ["0 10 * * 0,6", "Every Saturday and Sunday at 10:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday, and Friday at 09:00"],
    ["0 9 * * 0,1", "Every Monday and Sunday at 09:00"],
    ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
    ["0 9 1 * *", "Every month on the 1st at 09:00"],
    ["0 9 1,15 * *", "Every month on the 1st and 15th at 09:00"],
    ["0 8 25 12 *", "Every year on 25 December at 08:00"],
    ["0 0 9 * * 1", "Every Monday at 09:00"],
    ["0 9 * * 1#2", "On the schedule 0 9 * * 1#2"],
    ["0 9-17 * * *", "Every hour from 09:00 to 17:00"],
    ["30 9-17 * * 1-5", "Every weekday, every hour from 09:30 to 17:30"],
    ["0 1,5,9,13 * * *", "On the schedule 0 1,5,9,13 * * *"],
  ])("%s", (cron, text) => {
    expect(cronText(cron)).toBe(text);
  });
});

describe("a setting in words", () => {
  it("reads a schedule's cron and time, and leaves the rest", () => {
    expect(settingText("core.schedule", "cron", "0 9 * * 2")).toBe("Every Tuesday at 09:00");
    expect(settingText("core.schedule", "at", "2026-11-09T17:00")).toMatch(/^Monday 9 November/);
    expect(settingText("core.schedule", "timezone", "Europe/Lisbon")).toBeNull();
    expect(settingText("core.schedule", "cron", "")).toBeNull();
    expect(settingText("discord.send_message", "cron", "0 9 * * 2")).toBeNull();
  });
});
