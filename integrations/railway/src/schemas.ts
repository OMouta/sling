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
    .describe(
      "A Railway project token for the project that holds the environment, from Project Settings > Tokens. An account or workspace token works too: set the token type to match",
    ),
  tokenType: z
    .enum(["project", "account"])
    .default("project")
    .describe(
      "project for a project token (recommended: it reaches only that project). account for an account or workspace token",
    ),
  environmentId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "ID of the Railway environment sandboxes run in. Use one that holds nothing else, such as a project made for Sling",
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
    .describe(
      "Sling's public HTTPS URL, which sandboxes connect back to. Usually SLING_PUBLIC_URL",
    ),
  cpus: z
    .number()
    .positive()
    .max(32)
    .optional()
    .describe("vCPUs per sandbox. Empty uses your workspace's sandbox default"),
  memoryMb: z
    .number()
    .int()
    .min(512)
    .optional()
    .describe("Memory per sandbox, in MB. Empty uses your workspace's sandbox default"),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDLE_TIMEOUT_MINUTES)
    .default(5)
    .describe(
      "Minutes Railway keeps a sandbox after its container stops before destroying it. 1 to 5 on Trial and Free, up to 120 on Hobby and Pro",
    ),
  testCreatesSandbox: z
    .boolean()
    .default(false)
    .describe(
      "Make Test start a small sandbox, check Docker and the image in it, and destroy it. Takes about a minute and bills for that time",
    ),
});

export type RailwayConfig = z.infer<typeof configSchema>;
