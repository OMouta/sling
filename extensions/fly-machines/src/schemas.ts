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

const APP = { step: "App and image" } as const;
const MORE = { ...APP, advanced: true } as const;

export const credentialsSchema = z.object({
  apiToken: z.string().trim().min(1).meta({
    title: "API token",
    description: "fly tokens create deploy --app <app>, FlyV1 included",
  }),
});

export type FlyCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  app: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use the app's name: lowercase letters, digits, and -")
    .meta({ ...APP, title: "App", placeholder: "an empty app, just for sandboxes" }),
  image: z
    .string()
    .trim()
    .min(1)
    .meta({ ...APP, title: "Image", placeholder: "registry.fly.io/<app>:latest" }),
  region: z
    .string()
    .trim()
    .regex(/^([a-z]{3})?$/, "Use a three-letter region code, such as iad or fra")
    .optional()
    .meta({ ...MORE, title: "Region", placeholder: "Fly picks one" }),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine(
      isControlPlaneUrl,
      "Use Sling's https:// URL, or an http:// .internal or .flycast address on Fly's private network",
    )
    .optional()
    .meta({
      ...MORE,
      title: "Sling's address for sandboxes",
      placeholder: "This server's address",
    }),
  cpuKind: z
    .union([
      z.literal("shared").meta({ title: "Shared" }),
      z.literal("performance").meta({ title: "Performance" }),
    ])
    .default("shared")
    .meta({ ...MORE, title: "CPU kind", widget: "segmented" }),
  cpus: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .meta({ ...MORE, title: "CPUs per sandbox" }),
  memoryMb: z
    .number()
    .int()
    .min(256)
    .optional()
    .meta({ ...MORE, title: "Memory per sandbox, in MB" }),
  apiUrl: z
    .string()
    .trim()
    .default(DEFAULT_API_URL)
    .refine(isHttpUrl, "Use an https:// URL")
    .meta({ ...MORE, title: "Machines API URL" }),
});

export type FlyConfig = z.infer<typeof configSchema>;
