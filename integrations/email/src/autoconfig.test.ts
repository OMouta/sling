import { beforeEach, describe, expect, it } from "vitest";
import {
  type AutoconfigDeps,
  addressOf,
  clearAutoconfigCache,
  findServers,
  ISPDB_URL,
  parseAutoconfig,
} from "./autoconfig.ts";
import { createEmailConnector } from "./index.ts";

const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <displayName>Example Mail</displayName>
    <displayShortName>Example</displayShortName>
    <incomingServer type="pop3">
      <hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap-plain.example.org</hostname><port>143</port><socketType>plain</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>smtps.example.org</hostname><port>465</port><socketType>SSL</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function deps(
  pages: Record<string, string>,
  mx: Record<string, string> = {},
): AutoconfigDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (async (url: string | URL) => {
      const u = String(url);
      asked.push(u);
      const body = pages[u.slice(ISPDB_URL.length)];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }) as typeof fetch,
    resolveMx: async (domain) => {
      const exchange = mx[domain];
      if (!exchange) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [
        { exchange: "backup.invalid", priority: 20 },
        { exchange, priority: 10 },
      ];
    },
  };
}

const signal = () => AbortSignal.timeout(5_000);

beforeEach(() => clearAutoconfigCache());

describe("addressOf", () => {
  it("reads a bare address and one with a display name", () => {
    expect(addressOf("you@Example.com")).toEqual({
      address: "you@Example.com",
      domain: "example.com",
    });
    expect(addressOf("Sling <bot@acme.dev>")?.domain).toBe("acme.dev");
  });

  it("waits for a whole address", () => {
    for (const v of ["you", "you@", "you@gmail", "you@gmail.c", "", 3]) {
      expect(addressOf(v)).toBeNull();
    }
  });
});

describe("parseAutoconfig", () => {
  it("prefers TLS over STARTTLS, skips plain text, and reads the login style", () => {
    expect(parseAutoconfig(XML)).toEqual({
      provider: "Example",
      imap: { host: "imap.example.org", port: 143, secure: false },
      smtp: { host: "smtps.example.org", port: 465, secure: true },
      login: "local",
    });
  });

  it("gives up on a document without IMAP or SMTP", () => {
    expect(parseAutoconfig("<clientConfig><emailProvider/></clientConfig>")).toBeNull();
    expect(parseAutoconfig("not xml <<<")).toBeNull();
  });
});

describe("findServers", () => {
  it("answers the big providers without a lookup", async () => {
    const d = deps({});
    const found = await findServers("gmail.com", signal(), d);
    expect(found?.provider).toBe("Gmail");
    expect(found?.appPassword?.url).toContain("myaccount.google.com");
    expect(d.asked).toEqual([]);
  });

  it("asks the provider database, and remembers the answer", async () => {
    const d = deps({ "example.org": XML });
    expect((await findServers("example.org", signal(), d))?.imap.host).toBe("imap.example.org");
    await findServers("example.org", signal(), d);
    expect(d.asked).toHaveLength(1);
  });

  it("says Microsoft mailboxes can't be added", async () => {
    expect((await findServers("outlook.com", signal(), deps({})))?.unsupported).toMatch(
      /no longer accepts passwords/,
    );
  });

  it("follows the MX records to Google Workspace and Microsoft 365", async () => {
    const d = deps(
      {},
      {
        "acme.dev": "aspmx.l.google.com.",
        "contoso.dev": "contoso-dev.mail.protection.outlook.com",
      },
    );
    expect((await findServers("acme.dev", signal(), d))?.provider).toBe("Google Workspace");
    expect((await findServers("contoso.dev", signal(), d))?.smtp).toEqual({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
    });
  });

  it("asks the database for the MX host's domain too", async () => {
    const d = deps({ "mailhost.net": XML }, { "small.biz": "mx1.mailhost.net" });
    expect((await findServers("small.biz", signal(), d))?.imap.host).toBe("imap.example.org");
  });

  it("returns null when nothing knows the domain", async () => {
    expect(await findServers("nowhere.invalid", signal(), deps({}))).toBeNull();
  });
});

describe("the setup lookup", () => {
  const connector = createEmailConnector({ autoconfig: deps({ "example.org": XML }) });
  const log = { info() {}, warn() {}, error() {} };
  const setup = (credentials: Record<string, unknown>) =>
    // biome-ignore lint/style/noNonNullAssertion: the email connector has one.
    connector.setup!({ credentials, config: {}, log, signal: signal() });

  it("fills the servers and the login from the address", async () => {
    const out = await setup({ fromAddress: "ana@example.org" });
    expect(out.name).toBe("ana@example.org");
    expect(out.credentials).toMatchObject({
      imapHost: "imap.example.org",
      smtpHost: "smtps.example.org",
      smtpSecure: true,
      username: "ana",
    });
    expect(out.notes?.[0]).toMatchObject({ field: "fromAddress", tone: "ok", text: "Example" });
  });

  it("points at where to make an app password", async () => {
    const out = await setup({ fromAddress: "ana@gmail.com" });
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        field: "password",
        link: expect.objectContaining({ label: "Make one" }),
      }),
    );
  });

  it("stops at a mailbox that refuses passwords", async () => {
    const out = await setup({ fromAddress: "ana@hotmail.com" });
    expect(out).toEqual({
      notes: [{ field: "fromAddress", tone: "error", text: expect.stringContaining("Microsoft") }],
    });
  });

  it("shows the server fields when it can't find them", async () => {
    const out = await setup({ fromAddress: "ana@nowhere.invalid" });
    expect(out.reveal).toEqual(["imapHost", "smtpHost"]);
    expect(out.notes?.[0]?.tone).toBe("warn");
    // Not once they're typed in.
    expect(
      (await setup({ fromAddress: "ana@nowhere.invalid", imapHost: "a", smtpHost: "b" })).reveal,
    ).toBeUndefined();
  });

  it("does nothing until the address is whole", async () => {
    expect(await setup({ fromAddress: "ana@exa" })).toEqual({});
  });
});
