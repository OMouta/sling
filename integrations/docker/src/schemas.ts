import { z } from "zod";

export const CONNECTOR_ID = "docker";
export const DEFAULT_HOST = "unix:///var/run/docker.sock";
export const DEFAULT_IMAGE = "sling-sandbox:latest";

const HOST = /^(unix:\/\/\/\S+|tcp:\/\/[^/\s:]+:\d{1,5})$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables the control plane sets for every sandbox. `extraEnv` can't replace them. */
const RESERVED_ENV = /^(SLING_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/;

/** An optional PEM block. Empty means unset, since the form sends "" for empty fields. */
const pem = (what: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || v.includes("-----BEGIN"), `${what} must be PEM, starting -----BEGIN`)
    .optional();

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const MORE = { advanced: true } as const;

export const credentialsSchema = z.object({
  host: z
    .string()
    .trim()
    .regex(HOST, "Use unix:///path/to/docker.sock or tcp://host:port")
    .default(DEFAULT_HOST)
    .meta({ title: "Docker host", lookup: true, placeholder: DEFAULT_HOST }),
  tlsCa: pem("The CA certificate").meta({
    ...MORE,
    title: "CA certificate",
    description: "ca.pem, for a tcp:// host",
    widget: "textarea",
    lookup: true,
  }),
  tlsCert: pem("The client certificate").meta({
    ...MORE,
    title: "Client certificate",
    description: "cert.pem",
    widget: "textarea",
    lookup: true,
  }),
  tlsKey: pem("The client key").meta({
    ...MORE,
    title: "Client key",
    description: "key.pem",
    lookup: true,
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

export type DockerCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  image: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_IMAGE)
    .meta({ ...MORE, title: "Image", lookup: true }),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine((v) => v === "" || isHttpUrl(v), "Use an http:// or https:// URL")
    .optional()
    .meta({
      ...MORE,
      title: "Sling's address for sandboxes",
      placeholder: "This server's address",
    }),
  cpus: z
    .number()
    .positive()
    .max(512)
    .optional()
    .meta({ ...MORE, title: "CPUs per sandbox" }),
  memoryMb: z
    .number()
    .int()
    .min(128)
    .optional()
    .meta({ ...MORE, title: "Memory per sandbox, in MB" }),
  network: z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => v !== "host" && !v.startsWith("container:"),
      "Sandboxes can't share the host's or another container's network",
    )
    .default("bridge")
    .meta({ ...MORE, title: "Network" }),
  pullPolicy: z
    .union([
      z.literal("missing").meta({ title: "When missing" }),
      z.literal("always").meta({ title: "Always" }),
      z.literal("never").meta({ title: "Never" }),
    ])
    .default("missing")
    .meta({ ...MORE, title: "Pull the image", widget: "segmented" }),
  extraEnv: z
    .record(
      z
        .string()
        .regex(ENV_NAME, "Environment variable names are letters, digits, and _")
        .refine((k) => !RESERVED_ENV.test(k), "Sling sets SLING_* and API key variables itself"),
      z.string(),
    )
    .default({})
    .meta({
      ...MORE,
      title: "Extra environment",
      description: "Shown in plain text, so no secrets",
    }),
});

export type DockerConfig = z.infer<typeof configSchema>;
