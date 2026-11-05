import { describe, expect, it } from "vitest";
import { BODY_LIMIT, capBytes, parseEmail } from "./parse.ts";

const meta = { id: "INBOX:42:7", folder: "INBOX" };

const plain = [
  'From: "Ada Lovelace" <ada@example.com>',
  "To: Sling <me@example.com>, team: bob@example.com, carol@example.com;",
  "Cc: dave@example.com",
  "Subject: Quarterly numbers",
  "Date: Wed, 04 Nov 2026 09:30:00 +0100",
  "Message-ID: <q3@example.com>",
  "In-Reply-To: <q2@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Numbers attached.",
  "",
].join("\r\n");

describe("parseEmail", () => {
  it("produces the email type", async () => {
    expect(await parseEmail(plain, meta)).toEqual({
      id: "INBOX:42:7",
      messageId: "<q3@example.com>",
      folder: "INBOX",
      from: { name: "Ada Lovelace", address: "ada@example.com" },
      to: [
        { name: "Sling", address: "me@example.com" },
        { name: null, address: "bob@example.com" },
        { name: null, address: "carol@example.com" },
      ],
      cc: [{ name: null, address: "dave@example.com" }],
      subject: "Quarterly numbers",
      date: "2026-11-04T08:30:00.000Z",
      text: "Numbers attached.\n",
      html: null,
      inReplyTo: "<q2@example.com>",
    });
  });

  it("falls back to the HTML converted to text", async () => {
    const html = [
      "From: ada@example.com",
      "To: me@example.com",
      "Subject: Newsletter",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><h1>Hello</h1><p>Read <b>this</b>.</p></body></html>",
    ].join("\r\n");
    const email = await parseEmail(html, meta);
    expect(email.html).toContain("<h1>Hello</h1>");
    expect(email.text).toMatch(/HELLO|Hello/);
    expect(email.text).toContain("Read this.");
    expect(email.text).not.toContain("<");
    expect(email.messageId).toBeNull();
    expect(email.inReplyTo).toBeNull();
  });

  it("uses the server's date when the header is missing, and copes with no headers", async () => {
    const email = await parseEmail("\r\njust a body", {
      ...meta,
      internalDate: new Date("2026-11-01T00:00:00Z"),
    });
    expect(email).toMatchObject({
      from: { name: null, address: "" },
      to: [],
      cc: [],
      subject: "",
      date: "2026-11-01T00:00:00.000Z",
    });
  });

  it("caps the text at 200 KB", async () => {
    const big = plain.replace("Numbers attached.", "x".repeat(BODY_LIMIT * 2));
    const email = await parseEmail(big, meta);
    expect(Buffer.byteLength(email.text)).toBeLessThanOrEqual(BODY_LIMIT);
    expect(email.text.length).toBeGreaterThan(BODY_LIMIT - 10);
  });
});

describe("capBytes", () => {
  it("never splits a multi-byte character", () => {
    const text = "é".repeat(10); // 20 bytes
    const cut = capBytes(text, 7);
    expect(cut).toBe("ééé");
    expect(capBytes("short", 100)).toBe("short");
  });
});
