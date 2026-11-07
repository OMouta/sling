/**
 * A workflow's steps in plain words, in the order they run, for the card the
 * chat shows before you apply a workflow the assistant wrote. Each step's
 * words come from its type and settings, never from its label alone, so the
 * card says what a step does even when its label says otherwise. Steps that
 * reach outside Sling are marked.
 */
import type { WorkflowStepView } from "@sling/core";
import {
  type AnyNodeSpec,
  EXEC_ERROR,
  type ExecPortSpec,
  execOutputsOf,
  isExpression,
  type NodeInstance,
  type WorkflowDefinition,
} from "@sling/workflow";
import { localDateText, localTimeText } from "./one-time.ts";

/** What the summary may look up to name things, such as an account or a Discord channel. */
export interface StepNames {
  installation?(id: string): { name: string; config: Record<string, unknown> } | undefined;
  /** What the account's setup lookup calls a value, such as #general for a channel ID. */
  option?(installationId: string, value: string): string | undefined;
  workflow?(id: string): string | undefined;
}

interface Lookup {
  get(type: string, version: number): AnyNodeSpec | undefined;
}

/** Steps that only move values around between the others. */
const PLUMBING = new Set([
  "core.set_var",
  "core.get_var",
  "core.transform",
  "core.return",
  "state.kv_get",
  "state.kv_set",
]);

const QUOTE = 60;

function quote(text: string, max = QUOTE): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `“${one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one}”`;
}

/** A setting written as a plain value, not an expression or left empty. */
function plain(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && !isExpression(t) ? t : null;
}

function joinAnd(items: string[], word = "and"): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${word} ${items.at(-1)}`;
}

/** "Send to …" as "send to …" after a prefix, leaving GET or AI as they are. */
function lowerFirst(text: string): string {
  return /^[A-Z]{2}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function words(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

// ------------------------------------------------------------- schedules

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3).toLowerCase());

const pad = (n: number) => String(n).padStart(2, "0");

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

/** A cron list of numbers or names, such as 1,3 or MON-FRI, or null when it's anything else. */
function cronList(field: string, max: number, names: string[] = []): number[] | null {
  const one = (t: string) => {
    const named = names.indexOf(t.toLowerCase());
    if (named >= 0) return named;
    return /^\d+$/.test(t) ? Number(t) : Number.NaN;
  };
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [a, b, extra] = part.split("-");
    if (extra !== undefined || !a) return null;
    const from = one(a);
    const to = b === undefined ? from : one(b);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || to > max) return null;
    for (let i = from; i <= to; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** "Every Monday at 09:00", "Every 5 minutes", or the expression itself when it's unusual. */
export function cronText(cron: string): string {
  const fallback = `On the schedule ${cron.trim()}`;
  const f = cron.trim().split(/\s+/);
  if (f.length === 6) {
    if (f[0] !== "0") return fallback;
    f.shift();
  }
  if (f.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const everyDay = dom === "*" && mon === "*" && dow === "*";

  const minuteStep = /^\*\/(\d+)$/.exec(min);
  if (everyDay && hour === "*") {
    if (min === "*" || minuteStep?.[1] === "1") return "Every minute";
    if (minuteStep) return `Every ${Number(minuteStep[1])} minutes`;
    if (/^\d+$/.test(min)) {
      return Number(min) === 0 ? "Every hour" : `Every hour at ${pad(Number(min))} past`;
    }
    return fallback;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (everyDay && hourStep && /^\d+$/.test(min)) {
    const n = Number(hourStep[1]);
    const every = n === 1 ? "Every hour" : `Every ${n} hours`;
    return Number(min) === 0 ? every : `${every}, at ${pad(Number(min))} past`;
  }

  const minutes = cronList(min, 59);
  const hours = cronList(hour, 23);
  if (minutes?.length !== 1 || !hours?.length) return fallback;
  const m = minutes[0] ?? 0;
  const time = (h: number) => `${pad(h)}:${pad(m)}`;
  const first = hours[0] ?? 0;
  const last = hours.at(-1) ?? 0;
  const hourly = hours.length >= 3 && last - first === hours.length - 1;
  if (hours.length > 3 && !hourly) return fallback;
  const at = hourly
    ? `, every hour from ${time(first)} to ${time(last)}`
    : ` at ${joinAnd(hours.map(time))}`;

  let days: string | null = null;
  if (dom === "*" && mon === "*") {
    if (dow === "*")
      return hourly ? `Every hour from ${time(first)} to ${time(last)}` : `Every day${at}`;
    const list = cronList(dow, 7, DAY_ABBR)?.map((d) => d % 7);
    if (!list?.length) return fallback;
    const set = [...new Set(list)].sort((x, y) => x - y);
    // Monday first, as a week reads.
    const ordered = [...set.filter((d) => d !== 0), ...set.filter((d) => d === 0)];
    days =
      set.join() === "1,2,3,4,5"
        ? "Every weekday"
        : `Every ${joinAnd(ordered.map((d) => DAYS[d] ?? ""))}`;
  } else {
    const dates = cronList(dom, 31);
    if (!dates?.length || dates.includes(0) || dow !== "*") return fallback;
    if (mon === "*") days = `Every month on the ${joinAnd(dates.map(ordinal))}`;
    else {
      const months = cronList(mon, 12, ["", ...MONTH_ABBR]);
      if (months?.length !== 1 || dates.length !== 1 || !months[0]) return fallback;
      days = `Every year on ${dates[0]} ${MONTHS[months[0] - 1]}`;
    }
  }
  return `${days}${at}`;
}

/** A setting's value in words where a card reads it better that way, such as a cron expression. */
export function settingText(type: string, key: string, value: unknown): string | null {
  const v = plain(value);
  if (type !== "core.schedule" || !v) return null;
  if (key === "cron") return cronText(v);
  if (key === "at") return localTimeText(v);
  return null;
}

function scheduleText(config: Record<string, unknown>, now: Date): string {
  const at = plain(config.at);
  const zone = plain(config.timezone);
  const when = at ? `Once, on ${localTimeText(at, now)}` : cronText(String(config.cron ?? ""));
  return zone ? `${when} (${zone})` : when;
}

// ------------------------------------------------------------- each type

interface Described {
  text: string;
  sends?: boolean;
}

interface Args {
  node: NodeInstance;
  spec: AnyNodeSpec | undefined;
  config: Record<string, unknown>;
  names: StepNames;
  now: Date;
  /** Whether a data input has an edge, such as a message coming from an earlier step. */
  wired(port: string): boolean;
}

function account(a: Args, field = "installationId"): string | null {
  const id = plain(a.config[field]);
  return id ? (a.names.installation?.(id)?.name ?? null) : null;
}

function range(from: string, days: number, now: Date): string {
  const day = from === "today" || from === "tomorrow" ? from : localDateText(from, now);
  if (days === 1) {
    if (from === "today") return "today's calendar";
    if (from === "tomorrow") return "tomorrow's calendar";
    return `the calendar for ${day}`;
  }
  return from === "today"
    ? `the next ${days} days of the calendar`
    : `${days} days of the calendar from ${day}`;
}

function discordTarget(a: Args): string | null {
  const inst = plain(a.config.installationId);
  const named = (v: string) => (inst ? a.names.option?.(inst, v) : undefined);
  const channel = a.config.channelId;
  const user = a.config.userId;
  if (isExpression(channel) || (!plain(channel) && isExpression(user))) return null;
  const channelId = plain(channel);
  if (channelId) return named(channelId) ?? `channel ${channelId}`;
  const userId = plain(user);
  if (userId) return `a direct message to ${named(userId) ?? userId}`;
  const fallback = inst ? plain(a.names.installation?.(inst)?.config.defaultChannelId) : null;
  return fallback ? (named(fallback) ?? `channel ${fallback}`) : null;
}

const SETTLED: Record<string, string> = {
  finished: "finishes",
  approval_needed: "needs approval",
  delivered: "is delivered",
};

const DELIVERS: Record<string, string> = {
  push: ", and push the branch",
  pr: ", and open a pull request",
  deploy: ", and deploy it once you approve",
};

const TYPES: Record<string, (a: Args) => Described> = {
  "core.manual": () => ({ text: "When you run it" }),
  "core.schedule": (a) => ({ text: scheduleText(a.config, a.now) }),
  "core.webhook": () => ({ text: "When its webhook URL is called" }),
  "app.chat_message": () => ({ text: "When you send a message in a chat" }),
  "sling.conversation_update": () => ({ text: "When a task from its chat finishes or needs you" }),
  "sling.task_settled": (a) => {
    const reasons = Array.isArray(a.config.reasons) ? (a.config.reasons as string[]) : [];
    const all = Object.keys(SETTLED);
    const picked = reasons.length ? all.filter((r) => reasons.includes(r)) : all;
    return {
      text: `When a coding task ${joinAnd(
        picked.map((r) => SETTLED[r] ?? r),
        "or",
      )}`,
    };
  },
  "sling.approval_requested": () => ({ text: "When something needs your approval" }),
  "checks.changed": (a) => {
    const name = plain(a.config.check);
    const kind = plain(a.config.kind);
    const what = name ? quote(name, 40) : kind && kind !== "any" ? `a ${kind} check` : "a check";
    const on = plain(a.config.on);
    const verbs: Record<string, string> = {
      down: "goes down",
      up: "comes back up",
      met: "is met",
      missed: "is missed",
    };
    return { text: `When ${what} ${on && verbs[on] ? verbs[on] : "changes"}` };
  },

  "discord.message_received": (a) => {
    const bot = account(a) ?? "the bot";
    if (a.config.scope === "channels") {
      return {
        text: `When someone posts in a Discord channel ${bot} reads${a.config.requireMention ? ", mentioning it" : ""}`,
      };
    }
    if (a.config.scope === "any") return { text: `When someone messages ${bot} on Discord` };
    return { text: `When someone sends ${bot} a direct message on Discord` };
  },
  "email.received": (a) => {
    const box = account(a);
    const folder = plain(a.config.folder);
    const from = plain(a.config.fromContains);
    const subject = plain(a.config.subjectContains);
    return {
      text: [
        `When an email arrives${box ? ` in ${box}` : ""}`,
        folder && folder.toUpperCase() !== "INBOX" ? ` (${folder})` : "",
        from ? `, from ${quote(from, 40)}` : "",
        subject ? `, about ${quote(subject, 40)}` : "",
      ].join(""),
    };
  },

  "core.if": (a) => ({
    text: a.node.label?.trim() || `Check ${quote(String(a.config.condition ?? ""))}`,
  }),
  "core.switch": (a) => {
    const cases = Array.isArray(a.config.cases) ? (a.config.cases as { port?: string }[]) : [];
    return {
      text:
        a.node.label?.trim() ||
        `Check which applies: ${joinAnd(cases.map((c) => c.port ?? "").filter(Boolean), "or")}`,
    };
  },
  "core.for_each": (a) => ({ text: a.node.label?.trim() || "For each item" }),
  "core.wait": (a) => {
    if (a.config.mode === "until") {
      const until = plain(a.config.until);
      return { text: until ? `Wait until ${until}` : "Wait" };
    }
    const s = typeof a.config.seconds === "number" ? a.config.seconds : 60;
    const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const text =
      s % 86_400 === 0 && s > 0
        ? unit(s / 86_400, "day")
        : s % 3_600 === 0 && s > 0
          ? unit(s / 3_600, "hour")
          : s % 60 === 0 && s > 0
            ? unit(s / 60, "minute")
            : unit(s, "second");
    return { text: `Wait ${text}` };
  },
  "core.invoke_workflow": (a) => {
    const id = plain(a.config.workflowId);
    const name = id ? a.names.workflow?.(id) : undefined;
    return { text: name ? `Run the workflow ${name}` : "Run another workflow" };
  },

  "state.conversation": (a) => {
    const title = plain(a.config.title);
    return { text: title ? `Find or start the chat ${quote(title)}` : "Find or start its chat" };
  },
  "agent.assistant": (a) => {
    const message = plain(a.config.message);
    if (message && !a.wired("message")) return { text: `Ask the assistant: ${quote(message)}` };
    return {
      text: a.wired("message") || a.config.message ? "Ask the assistant" : "The assistant replies",
    };
  },
  "agent.delegate_coding_task": (a) => {
    const repo = plain(a.config.repo);
    const title = plain(a.config.title);
    const deliver = String(a.config.deliver ?? "pr");
    return {
      text: `Start a coding task${repo ? ` in ${repo}` : ""}${title ? `: ${quote(title)}` : ""}${DELIVERS[deliver] ?? ""}`,
      sends: deliver in DELIVERS,
    };
  },
  "human.approval": (a) => {
    const title = plain(a.config.title);
    return { text: title ? `Ask you to approve ${quote(title)}` : "Ask for your approval" };
  },

  "ai.prompt": (a) => {
    const prompt = plain(a.config.prompt);
    return { text: prompt ? `Ask AI: ${quote(prompt)}` : "Ask AI" };
  },
  "ai.extract": (a) => {
    const schema = a.config.schema as { properties?: Record<string, unknown> } | undefined;
    const keys = Object.keys(schema?.properties ?? {});
    return {
      text: keys.length
        ? `Use AI to pull out ${joinAnd(keys.slice(0, 4).map(words))}${keys.length > 4 ? ", and more" : ""}`
        : "Use AI to pull out the details",
    };
  },
  "ai.classify": (a) => {
    const labels = Array.isArray(a.config.labels)
      ? (a.config.labels as { label?: string }[]).map((l) => l.label ?? "").filter(Boolean)
      : [];
    return {
      text: labels.length ? `Use AI to sort it: ${joinAnd(labels, "or")}` : "Use AI to sort it",
    };
  },

  "http.request": (a) => {
    const method = String(a.config.method ?? "GET").toUpperCase();
    const url = plain(a.config.url);
    const where = url ? (url.length > QUOTE ? `${url.slice(0, QUOTE - 1)}…` : url) : "a URL";
    const reads = method === "GET" || method === "HEAD";
    return { text: reads ? `Fetch ${where}` : `${method} to ${where}`, sends: !reads };
  },
  "app.notify": (a) => {
    const title = plain(a.config.title);
    return { text: title ? `Notify your devices: ${quote(title)}` : "Notify your devices" };
  },
  "deploys.check": (a) => {
    const target = plain(a.config.target);
    return { text: target ? `Check ${target}` : "Check every deploy target" };
  },

  "calendar.list_events": (a) => {
    const from = plain(a.config.from) ?? "today";
    const days = typeof a.config.days === "number" ? a.config.days : Number(a.config.days ?? 1);
    return { text: `Read ${range(from, Number.isFinite(days) && days > 0 ? days : 1, a.now)}` };
  },
  "calendar.create_event": (a) => {
    const title = plain(a.config.title);
    const where = plain(a.config.calendar) ?? account(a) ?? "your calendar";
    return { text: `Add ${title ? quote(title) : "an event"} to ${where}`, sends: true };
  },
  "email.send": (a) => {
    const to = plain(a.config.to);
    const subject = plain(a.config.subject);
    return {
      text: `${to ? `Email ${to}` : "Send an email"}${subject ? `: ${quote(subject)}` : ""}`,
      sends: true,
    };
  },
  "discord.send_message": (a) => {
    const target = discordTarget(a);
    const text = target
      ? target.startsWith("a direct message")
        ? `Send ${target} on Discord`
        : `Send to Discord ${target}`
      : "Send a Discord message";
    return {
      text: a.config.approvalButtons ? `${text}, with Approve and Reject buttons` : text,
      sends: true,
    };
  },
  "ntfy.publish": (a) => {
    const topic = plain(a.config.topic);
    return { text: `Publish to ntfy${topic ? ` topic ${topic}` : ""}`, sends: true };
  },
};

/** A type this file doesn't know, such as an extension's: its assistant summary, else its title. */
function generic(a: Args): Described {
  const spec = a.spec;
  if (!spec) return { text: a.node.label?.trim() || a.node.type };
  const template = spec.assistant?.summary;
  let text = spec.title;
  if (template) {
    let complete = true;
    const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = plain(a.config[key]);
      if (!v) complete = false;
      return v ?? "";
    });
    if (complete) text = filled;
  }
  if (!spec.execInput) text = `When: ${text}`;
  // An action that reaches a connector's service and doesn't say otherwise counts as sending.
  const sends =
    spec.assistant?.sends ?? (spec.execInput && spec.category === "action" && !!spec.connector);
  return { text, sends };
}

// ------------------------------------------------------------- the order

/** Words for the branch a step starts, such as "If so" after an If, or null for the main path. */
function branchWords(node: NodeInstance, port: string, sourceText: string): string | null {
  if (port === EXEC_ERROR) return `If ${quote(node.label?.trim() || sourceText, 40)} fails`;
  switch (node.type) {
    case "core.if":
      return port === "true" ? "If so" : "If not";
    case "core.switch":
    case "ai.classify":
      return port === "default" ? "Otherwise" : `If ${port}`;
    case "core.for_each":
      return port === "done" ? "After the last one" : null;
    case "human.approval":
      return port === "approved"
        ? "If you approve"
        : port === "rejected"
          ? "If you reject it"
          : "If nobody answers";
    default:
      return null;
  }
}

/**
 * A definition's steps in the order they run: triggers first, then each
 * path from them, a branch's first step saying which branch it is. Steps
 * that only pass values along are left out.
 */
export function workflowSteps(
  definition: WorkflowDefinition,
  registry: Lookup,
  names: StepNames = {},
  now: Date = new Date(),
): WorkflowStepView[] {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const exec = new Map<string, string>();
  const wired = new Set<string>();
  for (const e of definition.edges) {
    if (e.kind === "exec") exec.set(`${e.from.node}\u0000${e.from.port}`, e.to.node);
    else wired.add(`${e.to.node}\u0000${e.to.port}`);
  }

  const describe = (node: NodeInstance): Described => {
    const spec = registry.get(node.type, node.version);
    const args: Args = {
      node,
      spec,
      config: node.config,
      names,
      now,
      wired: (port) => wired.has(`${node.id}\u0000${port}`),
    };
    const own = TYPES[node.type];
    const d = own ? own(args) : generic(args);
    return { text: d.text, sends: d.sends ?? spec?.assistant?.sends ?? false };
  };

  const isTrigger = (n: NodeInstance) => {
    const spec = registry.get(n.type, n.version);
    return spec ? !spec.execInput : false;
  };

  const out: WorkflowStepView[] = [];
  const seen = new Set<string>();
  const triggers = definition.nodes.filter(isTrigger);
  for (const [i, t] of triggers.entries()) {
    seen.add(t.id);
    const d = describe(t);
    out.push({
      nodeId: t.id,
      text: i === 0 ? d.text : `Or ${lowerFirst(d.text)}`,
      sends: d.sends ?? false,
    });
  }

  const ports = (node: NodeInstance): ExecPortSpec[] => {
    const spec = registry.get(node.type, node.version);
    const list = spec ? execOutputsOf(spec, node.config) : [];
    return spec?.execInput ? [...list, { name: EXEC_ERROR }] : list;
  };

  const visit = (id: string, prefix: string | null) => {
    if (seen.has(id)) return;
    const node = nodes.get(id);
    if (!node) return;
    seen.add(id);
    const shown = !PLUMBING.has(node.type);
    const d = describe(node);
    if (shown) {
      out.push({
        nodeId: id,
        text: prefix ? `${prefix}: ${lowerFirst(d.text)}` : d.text,
        sends: d.sends ?? false,
      });
    }
    follow(node, shown ? null : prefix, d.text);
  };

  const follow = (node: NodeInstance, carried: string | null, text: string) => {
    for (const p of ports(node)) {
      const to = exec.get(`${node.id}\u0000${p.name}`);
      if (!to) continue;
      visit(to, branchWords(node, p.name, text) ?? carried);
    }
  };

  for (const t of triggers) follow(t, null, "");
  // Anything no trigger reaches, which a valid workflow doesn't have.
  for (const n of definition.nodes) visit(n.id, null);
  return out;
}
