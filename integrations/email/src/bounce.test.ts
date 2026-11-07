import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  BOUNCE_WATCH_MS,
  type Bounce,
  bareId,
  bounceIn,
  checkSend,
  parseDeliveryStatus,
} from "./bounce.ts";
import type { EmailCredentials } from "./schemas.ts";

const ID = "<0123456789abcdef0123456789abcdef.sling@example.com>";

/** A delivery status report for one recipient, the way Postfix writes one. */
function report(fields: string, original = `Message-ID: ${ID}\r\nSubject: Invoice\r\n`) {
  return [
    "From: Mail Delivery System <MAILER-DAEMON@mx.example.com>",
    "To: me@example.com",
    "Subject: Undelivered Mail Returned to Sender",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "I'm sorry to have to inform you that your message could not be delivered.",
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.com",
    "",
    fields,
    "",
    "--b1",
    "Content-Type: text/rfc822-headers",
    "",
    original,
    "--b1--",
    "",
  ].join("\r\n");
}

describe("parseDeliveryStatus", () => {
  it("reads each recipient's block, with folded lines", () => {
    const text = [
      "Reporting-MTA: dns; mx.example.com",
      "Arrival-Date: Sat, 7 Nov 2026 14:00:00 +0000",
      "",
      "Final-Recipient: rfc822; jo@silva.pt",
      "Original-Recipient: rfc822;jo@silva.pt",
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 <jo@silva.pt>: Recipient address",
      "    rejected: User unknown",
      "",
      "Final-Recipient: rfc822; ana@silva.pt",
      "Action: delivered",
      "Status: 2.0.0",
    ].join("\r\n");
    expect(parseDeliveryStatus(text)).toEqual([
      {
        recipient: "jo@silva.pt",
        action: "failed",
        status: "5.1.1",
        diagnostic: "smtp; 550 5.1.1 <jo@silva.pt>: Recipient address rejected: User unknown",
      },
      { recipient: "ana@silva.pt", action: "delivered", status: "2.0.0", diagnostic: null },
    ]);
  });
});

describe("bounceIn", () => {
  const parse = (raw: string) => simpleParser(raw);

  it("says a failed recipient's reason in a few words when the status is a common one", async () => {
    const bounce = bounceIn(
      await parse(
        report(
          "Final-Recipient: rfc822; jo@silva.pt\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 User unknown",
        ),
      ),
    );
    expect(bounce).toEqual({
      kind: "failed",
      recipient: "jo@silva.pt",
      reason: "mailbox not found",
    });
  });

  it("falls back to the server's diagnostic, without its smtp prefix", async () => {
    const bounce = bounceIn(
      await parse(
        report(
          "Final-Recipient: rfc822; jo@silva.pt\r\nAction: failed\r\nStatus: 5.0.0\r\nDiagnostic-Code: smtp; 554 Rejected by policy",
        ),
      ),
    );
    expect(bounce?.reason).toBe("554 Rejected by policy");
  });

  it("tells a delay from a failure, and ignores a report that it arrived", async () => {
    const delayed = bounceIn(
      await parse(
        report("Final-Recipient: rfc822; jo@silva.pt\r\nAction: delayed\r\nStatus: 4.2.2"),
      ),
    );
    expect(delayed).toEqual({ kind: "delayed", recipient: "jo@silva.pt", reason: "mailbox full" });
    const delivered = bounceIn(
      await parse(
        report("Final-Recipient: rfc822; jo@silva.pt\r\nAction: delivered\r\nStatus: 2.0.0"),
      ),
    );
    expect(delivered).toBeNull();
  });

  it("reads a mail server's free-form notice", async () => {
    const raw = [
      "From: MAILER-DAEMON@mx.example.com",
      "Subject: failure notice",
      "",
      "Hi. This is the qmail-send program. I'm afraid I wasn't able to deliver your message.",
      "",
      "<jo@silva.pt>:",
      "550 5.2.1 The account is disabled",
      "",
      "--- Below this line is a copy of the message.",
      `Message-ID: ${ID}`,
      "",
    ].join("\r\n");
    expect(bounceIn(await parse(raw))).toEqual({
      kind: "failed",
      recipient: null,
      reason: "mailbox disabled",
    });
  });

  it("leaves an ordinary reply alone", async () => {
    const raw = `From: Jo <jo@silva.pt>\r\nSubject: Re: Invoice\r\nIn-Reply-To: ${ID}\r\n\r\nPaid, thanks.\r\n`;
    expect(bounceIn(await parse(raw))).toBeNull();
  });
});

describe("checkSend", () => {
  const credentials = {} as EmailCredentials;
  const sentAtMs = Date.parse("2026-11-07T14:00:00Z");
  const signal = new AbortController().signal;
  const finding = (bounce: Bounce | null) => async () => bounce;
  const at = (minutes: number) => sentAtMs + minutes * 60_000;

  it("waits while the watch lasts, looking often at first", async () => {
    const first = await checkSend(
      credentials,
      { messageId: ID, sentAtMs, recipients: 1 },
      { now: at(0), attempt: 1, signal, find: finding(null) },
    );
    expect(first).toEqual({
      state: "waiting",
      message: "Watching for a bounce",
      retryAfterSeconds: 30,
    });
    const later = await checkSend(
      credentials,
      { messageId: ID, sentAtMs, recipients: 1 },
      { now: at(5), attempt: 6, signal, find: finding(null) },
    );
    expect(later).toMatchObject({ state: "waiting", retryAfterSeconds: 120 });
    // The last look lands when the watch ends, not after.
    const last = await checkSend(
      credentials,
      { messageId: ID, sentAtMs, recipients: 1 },
      { now: at(9.5), attempt: 9, signal, find: finding(null) },
    );
    expect(last).toMatchObject({ state: "waiting", retryAfterSeconds: 30 });
  });

  it("passes once the watch is over with no bounce", async () => {
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: sentAtMs + BOUNCE_WATCH_MS, attempt: 10, signal, find: finding(null) },
      ),
    ).toEqual({ state: "passed", message: "No bounce after 10 minutes" });
  });

  it("fails on a bounce, naming the recipient when there were several", async () => {
    const bounce: Bounce = {
      kind: "failed",
      recipient: "jo@silva.pt",
      reason: "mailbox not found",
    };
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: at(1), attempt: 2, signal, find: finding(bounce) },
      ),
    ).toEqual({ state: "failed", message: "Bounced: mailbox not found" });
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 2 },
        { now: at(1), attempt: 2, signal, find: finding(bounce) },
      ),
    ).toEqual({ state: "failed", message: "Bounced for jo@silva.pt: mailbox not found" });
  });

  it("says a delay while waiting, and still passes when nothing bounced", async () => {
    const delayed: Bounce = { kind: "delayed", recipient: "jo@silva.pt", reason: "mailbox full" };
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: at(2), attempt: 3, signal, find: finding(delayed) },
      ),
    ).toMatchObject({ state: "waiting", message: "Delayed: mailbox full" });
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: at(10), attempt: 10, signal, find: finding(delayed) },
      ),
    ).toEqual({
      state: "passed",
      message: "Delayed by the recipient's server, but no bounce after 10 minutes",
    });
  });

  it("keeps waiting when the mailbox can't be read, and gives up unchecked at the end", async () => {
    const failing = async () => {
      throw new Error("connection refused");
    };
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: at(1), attempt: 2, signal, find: failing },
      ),
    ).toMatchObject({ state: "waiting" });
    expect(
      await checkSend(
        credentials,
        { messageId: ID, sentAtMs, recipients: 1 },
        { now: at(11), attempt: 11, signal, find: failing },
      ),
    ).toEqual({ state: "unchecked", message: "Couldn't look for a bounce: connection refused" });
  });

  it("searches for the ID without its brackets", () => {
    expect(bareId(ID)).toBe("0123456789abcdef0123456789abcdef.sling@example.com");
  });
});
