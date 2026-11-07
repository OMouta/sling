import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import { type AutoconfigDeps, addressOf, findServers } from "./autoconfig.ts";
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

export interface EmailConnectorOptions extends EmailSourceOptions {
  /** How server lookups reach the network. Tests replace it. */
  autoconfig?: AutoconfigDeps;
}

export function createEmailConnector(
  options: EmailConnectorOptions = {},
): ConnectorDefinition<EmailCredentials, EmailConfig> {
  return defineConnector<EmailCredentials, EmailConfig>({
    id: CONNECTOR_ID,
    name: "Email",
    description: "Read and send mail from your address.",
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

    async setup({ credentials, signal }) {
      const from = addressOf(credentials.fromAddress);
      if (!from) return {};
      const typed = (k: keyof EmailCredentials) =>
        typeof credentials[k] === "string" && credentials[k] !== "";
      const found = await findServers(from.domain, signal, options.autoconfig);
      if (!found) {
        // Someone who typed the servers already doesn't need to hear it.
        if (typed("imapHost") && typed("smtpHost")) return { name: from.address };
        return {
          name: from.address,
          credentials: { username: from.address },
          reveal: ["imapHost", "smtpHost"],
          notes: [
            {
              field: "fromAddress",
              tone: "warn",
              text: `Couldn't find the mail servers for ${from.domain}. Fill them in below.`,
            },
          ],
        };
      }
      const login = found.login === "local" ? from.address.split("@")[0] : from.address;
      return {
        name: from.address,
        credentials: {
          imapHost: found.imap.host,
          imapPort: found.imap.port,
          imapSecure: found.imap.secure,
          smtpHost: found.smtp.host,
          smtpPort: found.smtp.port,
          smtpSecure: found.smtp.secure,
          username: login,
        },
        notes: [
          {
            field: "fromAddress",
            tone: "ok",
            text: found.provider ?? `${found.imap.host} and ${found.smtp.host}`,
          },
          ...(found.appPassword
            ? [
                {
                  field: "password",
                  tone: "info" as const,
                  text: found.appPassword.label,
                  link: { label: "Make one", url: found.appPassword.url },
                },
              ]
            : []),
        ],
      };
    },

    nodes: [emailReceived, sendEmail],
    source: createEmailSource(options),
  });
}

export const connector = createEmailConnector();
