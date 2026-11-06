import { z } from "zod";

export const CONNECTOR_ID = "fly-machines";
export const DEFAULT_API_URL = "https://api.machines.dev";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Empty, or a URL sandboxes can reach: https, or http on Fly's private network. */
function isControlPlaneUrl(value: string): boolean {
  return value === "" || reachableFromFly(value);
}

/** Fly sandboxes reach Sling over HTTPS, or over plain HTTP on Fly's own private network. */
export function reachableFromFly(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && /\.(internal|flycast)$/.test(u.hostname);
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
      "A Fly.io token that can manage the app's Machines. Create one with fly tokens create deploy --app <app> and paste all of it, FlyV1 included",
    ),
});

export type FlyCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  app: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use the app's name: lowercase letters, digits, and -")
    .meta({ title: "App" })
    .describe(
      "The Fly app sandboxes run in. Create an empty one for Sling with fly apps create, and use it for nothing else",
    ),
  region: z
    .string()
    .trim()
    .regex(/^([a-z]{3})?$/, "Use a three-letter region code, such as iad or fra")
    .optional()
    .describe("Region code, such as iad or fra. Empty lets Fly pick"),
  image: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Sandbox image, on a registry Fly can pull from: a public one, or registry.fly.io/<app>:<tag> after fly deploy --build-only --push",
    ),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine(
      isControlPlaneUrl,
      "Use Sling's https:// URL, or an http:// .internal or .flycast address on Fly's private network",
    )
    .optional()
    .meta({ title: "Control plane URL" })
    .describe(
      "Sling's URL as sandboxes reach it. Empty uses SLING_PUBLIC_URL. A Sling running on Fly in the same organization can use its .internal or .flycast address",
    ),
  cpuKind: z
    .enum(["shared", "performance"])
    .default("shared")
    .meta({ title: "CPU kind" })
    .describe("shared for burstable CPUs, performance for dedicated ones"),
  cpus: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .meta({ title: "CPUs" })
    .describe("CPUs per sandbox. Empty uses your workspace's sandbox default, or 2"),
  memoryMb: z
    .number()
    .int()
    .min(256)
    .optional()
    .meta({ title: "Memory in MB" })
    .describe(
      "Memory per sandbox, rounded up to a multiple of 256. Empty uses your workspace's sandbox default, or 4096",
    ),
  apiUrl: z
    .string()
    .trim()
    .default(DEFAULT_API_URL)
    .refine(isHttpUrl, "Use an https:// URL")
    .meta({ title: "Machines API URL" })
    .describe("The Fly Machines API. Change it only to point at a test server"),
});

export type FlyConfig = z.infer<typeof configSchema>;
