import { z } from "zod";

export const CONNECTOR_ID = "docker";
export const DEFAULT_HOST = "unix:///var/run/docker.sock";
export const DEFAULT_IMAGE = "sling-sandbox:latest";

const HOST = /^(unix:\/\/\/\S+|tcp:\/\/[^/\s:]+:\d{1,5})$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables the control plane sets for every sandbox. `extraEnv` can't replace them. */
const RESERVED_ENV = /^(SLING_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/;

/** An optional PEM block. Empty means unset, since the form sends "" for empty fields. */
const pem = (what: string, help: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || v.includes("-----BEGIN"), `${what} must be PEM, starting -----BEGIN`)
    .optional()
    .describe(help);

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export const credentialsSchema = z.object({
  host: z
    .string()
    .trim()
    .regex(HOST, "Use unix:///path/to/docker.sock or tcp://host:port")
    .default(DEFAULT_HOST)
    .describe(
      "Docker endpoint. unix:///var/run/docker.sock for the local daemon, or tcp://host:2376 for a remote one over TLS",
    ),
  tlsCa: pem(
    "The CA certificate",
    "The CA certificate that signed the daemon's certificate, usually ca.pem. Only for tcp:// hosts",
  ).meta({ title: "CA certificate", widget: "textarea" }),
  tlsCert: pem(
    "The client certificate",
    "The client certificate the daemon trusts, usually cert.pem. Only for tcp:// hosts",
  ).meta({ title: "Client certificate", widget: "textarea" }),
  tlsKey: pem(
    "The client key",
    "The client certificate's private key, usually key.pem. Only for tcp:// hosts",
  ).meta({ title: "Client key" }),
  registryUsername: z
    .string()
    .trim()
    .optional()
    .describe("Registry username, if the image is in a private registry"),
  registryPassword: z
    .string()
    .optional()
    .describe("Registry password or access token, if the image is in a private registry"),
});

export type DockerCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  image: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_IMAGE)
    .describe(
      "Sandbox image. The default, sling-sandbox:latest, is built from deploy/sandbox/Dockerfile",
    ),
  controlPlaneUrl: z
    .string()
    .trim()
    .refine((v) => v === "" || isHttpUrl(v), "Use an http:// or https:// URL")
    .optional()
    .meta({ title: "Control plane URL" })
    .describe(
      "URL sandboxes use to reach Sling, for example http://sling:8080 on a compose network. Defaults to SLING_PUBLIC_URL",
    ),
  cpus: z
    .number()
    .positive()
    .max(512)
    .optional()
    .meta({ title: "CPUs" })
    .describe("CPU limit per sandbox, in cores"),
  memoryMb: z
    .number()
    .int()
    .min(128)
    .optional()
    .meta({ title: "Memory in MB" })
    .describe("Memory limit per sandbox, in MB. Swap is off, so this is a hard limit"),
  network: z
    .string()
    .trim()
    .min(1)
    .refine(
      (v) => v !== "host" && !v.startsWith("container:"),
      "Sandboxes can't share the host's or another container's network",
    )
    .default("bridge")
    .describe(
      "Docker network for sandboxes. bridge by default. Name a compose network, such as sling-sandboxes, to reach Sling by service name",
    ),
  pullPolicy: z
    .enum(["missing", "always", "never"])
    .default("missing")
    .describe(
      "When to pull the image: missing pulls only if it isn't on the host, always pulls every time, never uses what's there",
    ),
  extraEnv: z
    .record(
      z
        .string()
        .regex(ENV_NAME, "Environment variable names are letters, digits, and _")
        .refine((k) => !RESERVED_ENV.test(k), "Sling sets SLING_* and API key variables itself"),
      z.string(),
    )
    .default({})
    .meta({ title: "Extra environment" })
    .describe(
      "Extra environment variables for every sandbox, such as a proxy setting. Not for secrets: they're shown here in plain text",
    ),
});

export type DockerConfig = z.infer<typeof configSchema>;
