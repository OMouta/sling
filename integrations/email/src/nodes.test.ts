import type { TriggerEvent } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connector } from "./index.ts";
import { domainOf, emailReceived, messageIdFor, type ReceivedConfig, smtpError } from "./nodes.ts";
import type { Email } from "./schemas.ts";

const trigger = emailReceived.trigger;
if (!trigger) throw new Error("trigger missing");
/** Takes settings as the editor saves them: the trigger fills in defaults itself. */
const match = (e: TriggerEvent, config: Record<string, unknown>) =>
  trigger.match(e, config as ReceivedConfig);

function email(overrides: Partial<Email> = {}): Email {
  return {
    id: "INBOX:1:5",
    messageId: "<m@example.com>",
    folder: "INBOX",
    from: { name: "Ada Lovelace", address: "ada@Example.com" },
    to: [{ name: null, address: "me@example.com" }],
    cc: [],
    subject: "Invoice 2026-11",
    date: "2026-11-05T10:00:00.000Z",
    text: "Pay me",
    html: null,
    inReplyTo: null,
    ...overrides,
  };
}

function event(payload: Email, installationId = "inst_mail"): TriggerEvent {
  return { type: "email.received", workspaceId: "ws", installationId, payload, at: new Date() };
}

const base = { installationId: "inst_mail" };

describe("email.received match", () => {
  it("passes the email through for the default folder", () => {
    const e = email();
    expect(match(event(e), base)).toEqual({ outputs: { email: e } });
    expect(match(event(email({ folder: "inbox" })), base)).not.toBeNull();
    expect(match(event(email({ folder: "Receipts" })), base)).toBeNull();
    expect(
      match(event(email({ folder: "Receipts" })), { ...base, folder: "Receipts" }),
    ).not.toBeNull();
  });

  it("filters on the sender, ignoring case", () => {
    expect(match(event(email()), { ...base, fromContains: "example.com" })).not.toBeNull();
    expect(match(event(email()), { ...base, fromContains: "ADA@" })).not.toBeNull();
    expect(match(event(email()), { ...base, fromContains: "lovelace" })).not.toBeNull();
    expect(match(event(email()), { ...base, fromContains: "bob@" })).toBeNull();
    expect(match(event(email()), { ...base, fromContains: "  " })).not.toBeNull();
  });

  it("filters on the subject, ignoring case", () => {
    expect(match(event(email()), { ...base, subjectContains: "invoice" })).not.toBeNull();
    expect(match(event(email()), { ...base, subjectContains: "receipt" })).toBeNull();
    expect(
      match(event(email()), { ...base, fromContains: "ada", subjectContains: "receipt" }),
    ).toBeNull();
  });

  it("ignores other installations and other events", () => {
    expect(match(event(email(), "inst_other"), base)).toBeNull();
    expect(match({ ...event(email()), type: "discord.message_received" }, base)).toBeNull();
    expect(match(event(email()), {})).toBeNull();
  });
});

describe("email.send helpers", () => {
  it("derives a stable Message-ID from the idempotency key and the sender's domain", () => {
    const a = messageIdFor("run_1:n_send:0", "Sling <me@mail.example.com>");
    expect(a).toMatch(/^<[0-9a-f]{32}\.sling@mail\.example\.com>$/);
    expect(messageIdFor("run_1:n_send:0", "me@mail.example.com")).toBe(a);
    expect(messageIdFor("run_1:n_send:1", "me@mail.example.com")).not.toBe(a);
    expect(domainOf("no address")).toBe("localhost");
  });

  it("treats temporary SMTP failures as retryable and the rest as final", () => {
    expect(smtpError({ code: "EENVELOPE", responseCode: 451, message: "try later" })).toMatchObject(
      { code: "smtp_unavailable", retryable: true },
    );
    expect(smtpError({ code: "ECONNECTION", message: "refused" })).toMatchObject({
      retryable: true,
    });
    expect(
      smtpError({ code: "EENVELOPE", responseCode: 550, message: "no such user" }),
    ).toMatchObject({ code: "smtp_rejected", retryable: false });
    expect(smtpError({ code: "EAUTH", responseCode: 535, message: "bad" })).toMatchObject({
      code: "smtp_auth_failed",
      retryable: false,
    });
  });
});

describe("email connector definition", () => {
  it("declares credentials with defaults and a secret password", () => {
    expect(connector.id).toBe("email");
    expect(connector.secretFields).toEqual(["password"]);
    expect(connector.nodes.map((n) => n.type)).toEqual(["email.received", "email.send"]);
    expect(
      connector.credentialsSchema.parse({
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        username: "me@example.com",
        password: "app-password",
        fromAddress: "me@example.com",
      }),
    ).toMatchObject({ imapPort: 993, imapSecure: true, smtpPort: 465, smtpSecure: true });
    expect(connector.configSchema.parse({})).toEqual({ folders: ["INBOX"] });
  });

  it("describes every config field, for the editor's form", () => {
    const schemas = [
      connector.credentialsSchema,
      connector.configSchema,
      ...connector.nodes.map((n) => n.configSchema),
    ];
    for (const schema of schemas) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      for (const [key, prop] of Object.entries(json.properties)) {
        expect(prop.description, key).toBeTruthy();
      }
    }
  });

  it("marks the send fields as expressions and the body as a textarea", () => {
    const send = connector.nodes.find((n) => n.type === "email.send");
    expect(send?.expressionFields).toEqual(["to", "subject", "text", "inReplyTo"]);
    expect(send?.idempotent).toBe(false);
    const json = z.toJSONSchema(send?.configSchema ?? z.object({}), { io: "input" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(json.properties.text?.widget).toBe("textarea");
  });
});
