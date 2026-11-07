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

const TOKEN = { step: "Railway token" } as const;
const IMAGE = { step: "Sandbox image" } as const;
const MORE = { ...IMAGE, advanced: true } as const;

export const credentialsSchema = z.object({
  apiToken: z
    .string()
    .trim()
    .min(1)
    .meta({
      ...TOKEN,
      title: "API token",
      description: "From Account Settings → Tokens",
      order: 0,
    }),
  tokenType: z
    .union([
      z.literal("account").meta({ title: "Account or workspace" }),
      z.literal("project").meta({ title: "Project" }),
    ])
    .default("account")
    .meta({ ...TOKEN, advanced: true, title: "Token type", widget: "segmented" }),
  environmentId: z.string().trim().min(1).meta({
    title: "Environment ID",
    description: "Cmd+K or Ctrl+K in an empty project copies it",
    order: 1,
  }),
  registryUsername: z
    .string()
    .trim()
    .optional()
    .meta({ ...MORE, title: "Registry username" }),
  registryPassword: z
    .string()
    .optional()
    .meta({ ...MORE, title: "Registry password" }),
});

export type RailwayCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  image: z.string().trim().min(1).meta({
    title: "Image",
    placeholder: "ghcr.io/you/sling-sandbox:latest",
    description: "On a registry the sandbox can pull from",
  }),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine(isHttpsUrl, "Railway sandboxes reach Sling over the internet: use an https:// URL")
    .meta({ ...IMAGE, title: "Sling's public address", placeholder: "https://sling.example.com" }),
  cpus: z
    .number()
    .positive()
    .max(32)
    .optional()
    .meta({ ...MORE, title: "vCPUs per sandbox" }),
  memoryMb: z
    .number()
    .int()
    .min(512)
    .optional()
    .meta({ ...MORE, title: "Memory per sandbox, in MB" }),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_IDLE_TIMEOUT_MINUTES)
    .default(5)
    .meta({
      ...MORE,
      title: "Keep a stopped sandbox for, in minutes",
      description: "Up to 5 on Trial and Free, 120 on Hobby and Pro",
    }),
  testCreatesSandbox: z
    .boolean()
    .default(false)
    .meta({
      ...MORE,
      title: "Start a test sandbox when checking",
      description: "Takes about a minute, billed",
    }),
});

export type RailwayConfig = z.infer<typeof configSchema>;
