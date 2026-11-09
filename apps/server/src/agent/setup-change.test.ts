import type {
  CommandApprovalView,
  PermissionMode,
  ServerEvent,
  SetupChangeView,
} from "@sling/core";
import { schema } from "@sling/db";
import { connector as email } from "@sling/integration-email";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.ts";
import { toJsonSchema } from "../workflows/registry.ts";
import { Commands } from "./commands.ts";
import {
  DENIED,
  diff,
  fieldsOf,
  type Proposal,
  propose,
  REFUSED,
  redactSecrets,
  row,
  withoutSecrets,
  words,
} from "./setup-change.ts";
import { TraceRecorder } from "./trace.ts";

const SECRET = "hunter2-app-password";

/** A context with just what a proposal touches: the conversation's mode, approvals, and the audit. */
function fake(mode: PermissionMode) {
  const audits: Record<string, unknown>[] = [];
  const ctx = {
    db: {
      select: () => ({ from: () => ({ where: async () => [{ mode }] }) }),
      // A chat approval's own record isn't an audit entry.
      insert: (table: unknown) => ({
        values: async (v: Record<string, unknown>) => {
          if (table !== schema.chatApprovals) audits.push(v);
        },
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    },
    log: { error: () => {} },
  } as unknown as AppContext;
  (ctx as { commands: Commands }).commands = new Commands(ctx);
  const events: ServerEvent[] = [];
  const trace = new TraceRecorder("cnv_1", (ev) => events.push(ev));
  trace.toolStarted("call_1", "save_app_account", { connector: "email" });
  const scope = { workspaceId: "wsp_1", ownerId: "usr_1", conversationId: "cnv_1", trace };
  const approvals = () =>
    events.flatMap((e) => (e.type === "agent.tool" && e.step.approval ? [e.step.approval] : []));
  return { ctx, scope, trace, audits, events, approvals };
}

const change: SetupChangeView = {
  title: "Connect ana@example.com?",
  doing: "Connecting ana@example.com",
  done: "Connected ana@example.com",
  rows: [row("App", "Email"), row("IMAP server", "imap.example.com")],
  secrets: [{ key: "password", label: "Password", required: true }],
};

function proposal(apply: Proposal["apply"], over: Partial<SetupChangeView> = {}): Proposal {
  return {
    tool: "save_app_account",
    subjectType: "installation",
    subjectId: "",
    change: { ...change, ...over },
    apply,
  };
}

const call = { toolCallId: "call_1" };

async function pending(approvals: () => CommandApprovalView[]): Promise<CommandApprovalView> {
  await vi.waitFor(() => expect(approvals().at(-1)?.state).toBe("pending"));
  const a = approvals().at(-1);
  if (!a) throw new Error("no approval");
  return a;
}

describe("the fields of a connector", () => {
  it("come in the form's order, with titles, and say which are secret and required", () => {
    const fields = fieldsOf(toJsonSchema(email.credentialsSchema), email.secretFields);
    expect(fields.slice(0, 3).map((f) => f.key)).toEqual(["fromAddress", "password", "imapHost"]);
    const by = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(by.fromAddress).toMatchObject({ title: "Email address", secret: false, required: true });
    expect(by.password).toMatchObject({ title: "Password", secret: true, required: true });
    // A field with a default is filled in when left out.
    expect(by.imapPort).toMatchObject({ title: "IMAP port", required: false, advanced: true });
  });

  it("turns a key without a title into words", () => {
    expect(words("imapHost")).toBe("Imap host");
    expect(words("bot_token")).toBe("Bot token");
  });

  it("never keeps a secret the model passed", () => {
    expect(withoutSecrets({ fromAddress: "a@b.c", password: "x" }, ["password"])).toEqual({
      kept: { fromAddress: "a@b.c" },
      dropped: ["password"],
    });
  });
});

describe("rows of a change", () => {
  it("shows a new value, and an edit only when it changes", () => {
    expect(row("On", true)).toEqual({ label: "On", after: "On" });
    expect(row("Folders", ["INBOX", "Work"])).toEqual({ label: "Folders", after: "INBOX, Work" });
    expect(diff("Name", "Site", "Site")).toEqual([]);
    expect(diff("Name", "Site", "Website")).toEqual([
      { label: "Name", before: "Site", after: "Website" },
    ]);
  });

  it("takes typed secrets out of an error", () => {
    expect(redactSecrets(`login failed for ${SECRET}`, { password: SECRET })).toBe(
      "login failed for [redacted]",
    );
  });
});

describe("approving a change", () => {
  it("takes only the secrets the card asked for, and needs the required ones", async () => {
    const { ctx } = fake("auto");
    const seen: CommandApprovalView[] = [];
    let answer: Promise<unknown> = Promise.resolve();
    const id = await new Promise<string>((resolve) => {
      answer = ctx.commands.change({
        workspaceId: "wsp_1",
        conversationId: "cnv_1",
        change,
        onChange: (v) => {
          seen.push(v);
          resolve(v.id);
        },
      });
    });
    expect(seen[0]).toMatchObject({ kind: "change", state: "pending", summary: change.title });
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", { token: "x" })).toBe(
      "bad_secrets",
    );
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", {})).toBe("missing_secrets");
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", { password: "   " })).toBe(
      "missing_secrets",
    );
    // Another conversation can't answer it.
    expect(ctx.commands.decide("wsp_1", "cnv_2", id, "approve", { password: SECRET })).toBe("gone");
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", { password: SECRET })).toBe("ok");
    expect(await answer).toEqual({ decision: "approved", secrets: { password: SECRET } });
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", { password: SECRET })).toBe("gone");
    // What the chat saw never held the secret.
    expect(seen.map((v) => v.state)).toEqual(["pending", "approved"]);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  it("refuses secrets for a send", async () => {
    const { ctx } = fake("auto");
    const id = await new Promise<string>((resolve) => {
      void ctx.commands.approval({
        workspaceId: "wsp_1",
        conversationId: "cnv_1",
        kind: "send",
        summary: "Email ana",
        onChange: (v) => resolve(v.id),
      });
    });
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve", { password: "x" })).toBe(
      "bad_secrets",
    );
    expect(ctx.commands.decide("wsp_1", "cnv_1", id, "approve")).toBe("ok");
  });
});

describe("proposing a change", () => {
  it("refuses in Read-only, and audits that", async () => {
    const { ctx, scope, audits } = fake("read-only");
    const apply = vi.fn();
    const out = await propose(ctx, scope, call, proposal(apply));
    expect(out).toEqual({ error: REFUSED });
    expect(apply).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({
      verb: "assistant.change",
      details: expect.objectContaining({ decision: "refused", ok: false }),
    });
  });

  it("asks, then applies with the typed secret, which goes nowhere else", async () => {
    const { ctx, scope, trace, audits, events, approvals } = fake("supervised");
    let got: Record<string, string> = {};
    const result = propose(
      ctx,
      scope,
      call,
      proposal(async (secrets) => {
        got = secrets;
        return { ok: true, subjectId: "ins_1", result: { account: { name: "ana@example.com" } } };
      }),
    );
    const a = await pending(approvals);
    expect(a.change?.secrets).toEqual(change.secrets);
    expect(ctx.commands.decide("wsp_1", "cnv_1", a.id, "approve", { password: SECRET })).toBe("ok");
    const out = await result;
    expect(got).toEqual({ password: SECRET });
    expect(out).toEqual({ applied: true, account: { name: "ana@example.com" } });
    expect(approvals().at(-1)?.state).toBe("approved");
    expect(audits[0]).toMatchObject({
      subjectId: "ins_1",
      details: expect.objectContaining({
        decision: "approved",
        ok: true,
        secretFields: ["password"],
      }),
    });
    trace.toolFinished("call_1", true, out);
    for (const where of [out, audits, events, trace.finish("").trace]) {
      expect(JSON.stringify(where)).not.toContain(SECRET);
    }
  });

  it("changes nothing when the user cancels", async () => {
    const { ctx, scope, audits, approvals } = fake("auto");
    const apply = vi.fn();
    const result = propose(ctx, scope, call, proposal(apply));
    const a = await pending(approvals);
    ctx.commands.decide("wsp_1", "cnv_1", a.id, "deny");
    expect(await result).toEqual({ error: DENIED });
    expect(apply).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ details: expect.objectContaining({ decision: "denied" }) });
  });

  it("applies at once in Full access, still showing what changed", async () => {
    const { ctx, scope, approvals, audits } = fake("full-access");
    const out = await propose(
      ctx,
      scope,
      call,
      proposal(async () => ({ ok: true, subjectId: "wsp_1", result: {} }), { secrets: [] }),
    );
    expect(out).toEqual({ applied: true });
    expect(approvals().map((a) => a.state)).toEqual(["approved"]);
    expect(approvals()[0]?.change?.title).toBe(change.title);
    expect(audits[0]).toMatchObject({
      details: expect.objectContaining({ decision: "full_access" }),
    });
  });

  it("still asks in Full access when the change needs a secret", async () => {
    const { ctx, scope, approvals } = fake("full-access");
    const result = propose(
      ctx,
      scope,
      call,
      proposal(async () => ({ ok: true, subjectId: "ins_1", result: {} })),
    );
    const a = await pending(approvals);
    ctx.commands.decide("wsp_1", "cnv_1", a.id, "approve", { password: SECRET });
    expect(await result).toEqual({ applied: true });
  });

  it("keeps a typed secret out of an error that echoes it", async () => {
    const { ctx, scope, audits, approvals } = fake("auto");
    const result = propose(
      ctx,
      scope,
      call,
      proposal(async (s) => ({ ok: false, error: `Bad password ${s.password}` })),
    );
    const a = await pending(approvals);
    ctx.commands.decide("wsp_1", "cnv_1", a.id, "approve", { password: SECRET });
    const out = await result;
    expect(out).toEqual({ error: "Bad password [redacted]" });
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });
});
