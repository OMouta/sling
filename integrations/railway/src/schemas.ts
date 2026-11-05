import { z } from "zod";

export const CONNECTOR_ID = "railway";

/** Railway's ceiling for a finite idle timeout, on Hobby and Pro. Trial and Free stop at 5. */
export const MAX_IDLE_TIMEOUT_MINUTES = 120;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const credentialsSchema = z.object({
  apiToken: z
    .string()
    .trim()
    .min(1)
    .meta({ title: "API token" })
    .describe(
      "A Railway account or workspace token, from Account Settings > Tokens or the workspace's settings. A project token works too: set the token type to project",
    ),
  tokenType: z
    .enum(["account", "project"])
    .default("account")
    .describe(
      "account for an account or workspace token, which Railway's sandbox docs use. project for a project token, which reaches only one environment",
    ),
  environmentId: z
    .string()
    .trim()
    .min(1)
    .meta({ title: "Environment ID" })
    .describe(
      "ID of the Railway environment sandboxes run in. Press Cmd+K or Ctrl+K in the project to copy it. Use an environment that holds nothing else",
    ),
  registryUsername: z
    .string()
    .trim()
    .optional()
    .describe("Registry username, if the image is in a private registry"),
  registryPassword: z
    .string()
    .optional()
    .describe(
      "Registry password or a read-only access token, if the image is in a private registry",
    ),
});

export type RailwayCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  image: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Sandbox image, pulled from inside each Railway sandbox, so it must be on a registry: public, or private with the registry login set. For example ghcr.io/you/sling-sandbox:latest",
    ),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine(isHttpsUrl, "Railway sandboxes reach Sling over the internet: use an https:// URL")
    .meta({ title: "Control plane URL" })
    .describe(
      "Sling's public HTTPS URL, which sandboxes connect back to. Usually SLING_PUBLIC_URL",
    ),
  cpus: z
    .number()
    .positive()
    .max(32)
    .optional()
    .meta({ title: "CPUs" })
    .describe("vCPUs per sandbox. Empty uses your workspace's sandbox default"),
  memoryMb: z
    .number()
    .int()
    .min(512)
    .optional()
    .meta({ title: "Memory in MB" })
    .describe("Memory per sandbox, in MB. Empty uses your workspace's sandbox default"),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDLE_TIMEOUT_MINUTES)
    .default(5)
    .meta({ title: "Idle timeout in minutes" })
    .describe(
      "Minutes Railway keeps a sandbox after its container stops before destroying it. 1 to 5 on Trial and Free, up to 120 on Hobby and Pro",
    ),
  testCreatesSandbox: z
    .boolean()
    .default(false)
    .meta({ title: "Check in a test sandbox" })
    .describe(
      "Make Test start a small sandbox, check Docker and the image in it, and destroy it. Takes about a minute and bills for that time",
    ),
});

export type RailwayConfig = z.infer<typeof configSchema>;
