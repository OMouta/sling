import { CHECK_KINDS, START_RULE_EVENTS } from "@sling/core";
import { z } from "zod";
import { defineNode } from "../types.ts";

/** What a check changing is offered to workflows as. */
export const CHECKS_CHANGED = "checks.changed";

interface ChangedPayload {
  check: { name: string; kind: string; state: string; reason: string; sinceTime: string } & Record<
    string,
    unknown
  >;
  open: string;
  conversationId: string | null;
}

/** Starts a workflow when a check changes, which Sling's own scheduler notices. */
export const checksChangedTrigger = defineNode({
  type: "checks.changed",
  version: 1,
  title: "Check changed",
  description:
    "Starts when one of your checks goes down, comes back up, or a reply check is met or missed. Sling runs the checks on its own schedule.",
  category: "trigger",
  configSchema: z.object({
    check: z.string().max(200).default("").describe("A check's name. Leave empty for every check."),
    kind: z
      .enum(["any", ...CHECK_KINDS])
      .default("any")
      .describe("Which kind of check: site, command, reply, or any of them."),
    on: z
      .enum(["any", ...START_RULE_EVENTS])
      .default("any")
      .describe("Which change: down, up, met, missed, or any of them."),
  }),
  inputs: [],
  outputs: [
    {
      name: "check",
      type: "json",
      description:
        "The check: id, name, kind, state, from, message, reason, since, sinceTime, results, and deployTarget.",
    },
    { name: "name", type: "string", description: "The check's name." },
    { name: "state", type: "string", description: "down, up, met, or missed." },
    {
      name: "reason",
      type: "string",
      description: 'Why it went down, such as "503". Empty when it came back.',
    },
    { name: "sinceTime", type: "string", description: "When it changed, as HH:MM." },
    {
      name: "open",
      type: "string",
      description:
        "The page a notification about it opens: the chat a start rule opened, or a new chat with a draft that says what happened.",
    },
  ],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: CHECKS_CHANGED,
    match: (e, config) => {
      const p = e.payload as ChangedPayload;
      const want = config.check.trim().toLowerCase();
      if (want && p.check.name.toLowerCase() !== want) return null;
      if (config.kind !== "any" && p.check.kind !== config.kind) return null;
      if (config.on !== "any" && p.check.state !== config.on) return null;
      return {
        outputs: {
          check: p.check,
          name: p.check.name,
          state: p.check.state,
          reason: p.check.reason,
          sinceTime: p.check.sinceTime,
          open: p.open,
        },
      };
    },
  },
});

export const checkNodes = [checksChangedTrigger];
