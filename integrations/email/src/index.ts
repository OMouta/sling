import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import { errorMessage } from "./backoff.ts";
import { closeImap, imapClient, imapErrorMessage, smtpTransport } from "./clients.ts";
import { emailReceived, sendEmail } from "./nodes.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type EmailConfig,
  type EmailCredentials,
} from "./schemas.ts";
import { createEmailSource, type EmailSourceOptions } from "./source.ts";

export type { Email, EmailAddress, EmailConfig, EmailCredentials } from "./schemas.ts";

const TEST_TIMEOUT_MS = 20_000;

async function testImap(
  credentials: EmailCredentials,
  folders: string[],
  signal: AbortSignal,
): Promise<string | null> {
  const client = imapClient(credentials, {
    connectionTimeout: TEST_TIMEOUT_MS,
    greetingTimeout: TEST_TIMEOUT_MS,
    disableAutoIdle: true,
  });
  client.on("error", () => {});
  const onAbort = () => client.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    for (const folder of folders) {
      try {
        await client.status(folder, { messages: true });
      } catch {
        return `IMAP login worked, but there's no folder called "${folder}".`;
      }
    }
    return null;
  } catch (error) {
    return imapErrorMessage(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await closeImap(client);
  }
}

async function testSmtp(
  credentials: EmailCredentials,
  signal: AbortSignal,
): Promise<string | null> {
  const transport = smtpTransport(credentials);
  const onAbort = () => transport.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await transport.verify();
    return null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EAUTH") {
      return `SMTP login failed: ${errorMessage(error)}. Check the username, and use an app password if your provider requires one.`;
    }
    return `SMTP check failed: ${errorMessage(error)}`;
  } finally {
    signal.removeEventListener("abort", onAbort);
    transport.close();
  }
}

export function createEmailConnector(
  options: EmailSourceOptions = {},
): ConnectorDefinition<EmailCredentials, EmailConfig> {
  return defineConnector<EmailCredentials, EmailConfig>({
    id: CONNECTOR_ID,
    name: "Email",
    description:
      "Any mailbox over IMAP and SMTP. Workflows can react to new mail and send email from your address.",
    setupHelp:
      "Use your provider's IMAP and SMTP servers and an app password. Gmail: imap.gmail.com and smtp.gmail.com, with an app password from your Google account's security settings (needs 2-Step Verification). Fastmail: imap.fastmail.com and smtp.fastmail.com, with an app password from Settings > Privacy & Security.",
    credentialsSchema,
    secretFields: ["password"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      const folders = config.folders?.length ? config.folders : ["INBOX"];
      const imapProblem = await testImap(credentials, folders, signal);
      if (imapProblem) return { ok: false, error: imapProblem };
      const smtpProblem = await testSmtp(credentials, signal);
      if (smtpProblem) return { ok: false, error: smtpProblem };
      return { ok: true, detail: `IMAP and SMTP logins worked. Watching ${folders.join(", ")}.` };
    },

    nodes: [emailReceived, sendEmail],
    source: createEmailSource(options),
  });
}

export const connector = createEmailConnector();
