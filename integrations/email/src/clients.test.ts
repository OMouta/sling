import { describe, expect, it } from "vitest";
import { imapClient, isLoopback, smtpTransport } from "./clients.ts";
import type { EmailCredentials } from "./schemas.ts";

const credentials = (host: string, secure: boolean): EmailCredentials =>
  ({
    imapHost: host,
    imapPort: secure ? 993 : 143,
    imapSecure: secure,
    smtpHost: host,
    smtpPort: secure ? 465 : 587,
    smtpSecure: secure,
    username: "jo@silva.pt",
    password: "secret",
    fromAddress: "jo@silva.pt",
  }) as EmailCredentials;

describe("mail clients", () => {
  it("require STARTTLS when TLS isn't direct", () => {
    const c = credentials("mail.silva.pt", false);
    expect(imapClient(c).options.doSTARTTLS).toBe(true);
    expect(smtpTransport(c).options).toMatchObject({ requireTLS: true, secure: false });
  });

  it("leave direct TLS as it is", () => {
    const c = credentials("mail.silva.pt", true);
    expect(imapClient(c).options.doSTARTTLS).toBeUndefined();
    expect(smtpTransport(c).options).toMatchObject({ requireTLS: false, secure: true });
  });

  it("allow cleartext only to this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "bridge.localhost"]) {
      expect(isLoopback(host), host).toBe(true);
      expect(imapClient(credentials(host, false)).options.doSTARTTLS, host).toBeUndefined();
    }
    for (const host of ["10.0.0.2", "localhost.evil.io", "128.0.0.1", "mail.silva.pt"]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});
