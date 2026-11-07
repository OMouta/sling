import { NodeError } from "@sling/connector-sdk";
import { describe, expect, it } from "vitest";
import { connector } from "./index.ts";
import { parseMessageRef, resolveFolder, searchCriteria, snippetOf } from "./mailbox.ts";
import { readConfigSchema, searchConfigSchema } from "./nodes.ts";

describe("searchCriteria", () => {
  it("maps each field to its IMAP search key", () => {
    expect(
      searchCriteria({
        from: " jo@silva.pt ",
        to: "me",
        subject: "Invoice",
        text: "boiler",
        since: "2026-11-01",
        before: "2026-11-08",
        unread: true,
      }),
    ).toEqual({
      from: "jo@silva.pt",
      to: "me",
      subject: "Invoice",
      text: "boiler",
      since: "2026-11-01",
      before: "2026-11-08",
      seen: false,
    });
    expect(searchCriteria({ unread: false })).toEqual({ seen: true });
  });

  it("matches everything when nothing narrows it", () => {
    expect(searchCriteria({})).toEqual({ all: true });
    expect(searchCriteria({ from: "  ", text: "" })).toEqual({ all: true });
  });

  it("refuses dates it can't read, and a range that ends before it starts", () => {
    expect(() => searchCriteria({ since: "last week" })).toThrow(/since should be a date/);
    expect(() => searchCriteria({ before: "2026-13-40" })).toThrow(NodeError);
    expect(() => searchCriteria({ since: "2026-11-08", before: "2026-11-01" })).toThrow(
      /before has to be after since/,
    );
  });
});

describe("resolveFolder", () => {
  const list = [
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
    { path: "Receipts", specialUse: undefined },
    { path: "Archive/2026", specialUse: "\\Archive" },
  ] as { path: string; specialUse?: string }[];

  it("finds INBOX in any case, exact paths, and names that differ in case", () => {
    expect(resolveFolder("inbox", list)).toBe("INBOX");
    expect(resolveFolder("", list)).toBe("INBOX");
    expect(resolveFolder("Receipts", list)).toBe("Receipts");
    expect(resolveFolder("receipts", list)).toBe("Receipts");
  });

  it("finds a special folder by the name people use for it", () => {
    expect(resolveFolder("Sent", list)).toBe("[Gmail]/Sent Mail");
    expect(resolveFolder("sent items", list)).toBe("[Gmail]/Sent Mail");
    expect(resolveFolder("Archive", list)).toBe("Archive/2026");
  });

  it("lists the folders there are when it can't find one", () => {
    expect(() => resolveFolder("Bills", list)).toThrow(
      "There's no folder called Bills. Folders: INBOX, [Gmail]/Sent Mail, Receipts, Archive/2026.",
    );
  });
});

describe("parseMessageRef", () => {
  it("reads the folder from the left and the numbers from the right", () => {
    expect(parseMessageRef("INBOX:1700000000:42")).toEqual({
      folder: "INBOX",
      uidValidity: "1700000000",
      uid: 42,
    });
    expect(parseMessageRef("Work:Clients:9:3")).toEqual({
      folder: "Work:Clients",
      uidValidity: "9",
      uid: 3,
    });
  });

  it("refuses anything else", () => {
    for (const bad of ["42", "INBOX:x:1", "INBOX:1:0", ":1:2", "<m@example.com>"]) {
      expect(() => parseMessageRef(bad), bad).toThrow(/isn't a message ID/);
    }
  });
});

describe("snippetOf", () => {
  it("puts the text on one line and cuts it at 200 characters", () => {
    expect(snippetOf("Hi Jo,\n\n  the invoice\tis attached.\n")).toBe(
      "Hi Jo, the invoice is attached.",
    );
    const long = snippetOf("word ".repeat(100));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the nodes", () => {
  it("are offered to the assistant as reads that never ask", () => {
    const byType = new Map(connector.nodes.map((n) => [n.type, n]));
    for (const type of ["email.search", "email.read"]) {
      const node = byType.get(type);
      expect(node?.assistant, type).toMatchObject({ sends: false });
      expect(node?.idempotent, type).toBe(true);
      expect(node?.execInput, type).toBe(true);
    }
    expect(byType.get("email.send")?.assistant).toMatchObject({ sends: true, ruleFields: ["to"] });
  });

  it("take what the model sends, with defaults for the rest", () => {
    expect(searchConfigSchema.parse({ installationId: "ins_1", from: "jo" })).toEqual({
      installationId: "ins_1",
      folder: "INBOX",
      from: "jo",
      limit: 20,
    });
    expect(searchConfigSchema.safeParse({ installationId: "i", limit: 51 }).success).toBe(false);
    expect(searchConfigSchema.safeParse({ installationId: "i", since: "Monday" }).success).toBe(
      false,
    );
    expect(readConfigSchema.safeParse({ installationId: "i", id: "INBOX:1:2" }).success).toBe(true);
  });
});
