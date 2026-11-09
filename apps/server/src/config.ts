import { z } from "zod";
import { DEFAULT_SHUTDOWN_MS } from "./lifecycle.ts";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** URL people's browsers use to reach Sling, for example https://sling.example.com. */
  SLING_PUBLIC_URL: z.url(),
  /** Master secret. Encryption and auth keys are derived from it. */
  SLING_SECRET_KEY: z.string().min(32, "SLING_SECRET_KEY must be at least 32 characters"),
  SLING_SOURCE_STORAGE_BYTES: z.coerce.number().int().nonnegative().default(1073741824),
  SLING_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** Bearer token for `/metrics`. Unset, the endpoint answers 404. */
  SLING_METRICS_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32, "SLING_METRICS_TOKEN must be at least 32 characters").optional(),
  ),
  SLING_WEBHOOK_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  SLING_HTTP_ALLOWED_ORIGINS: z.string().default(""),
  SLING_TRUSTED_PROXIES: z.string().default(""),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /**
   * Longest a stop may take, from the signal to closed connections. Keep it below the
   * container's stop grace period, or the container is killed before cleanup finishes.
   */
  SLING_SHUTDOWN_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive()
    .max(3600)
    .default(DEFAULT_SHUTDOWN_MS / 1000),
  /** Directory with the built web app. Unset in development, where Vite serves it. */
  SLING_WEB_DIST: z.string().optional(),
  /** Image sandboxes run when their provider doesn't name one. */
  SLING_SANDBOX_IMAGE: z.string().min(1).optional(),
  /** Install unsigned extension packages. For developing extensions; the web app can't turn it on. */
  SLING_ALLOW_UNSIGNED_EXTENSIONS: z
    .enum(["0", "1", "true", "false", ""])
    .default("")
    .transform((v) => v === "1" || v === "true"),
  /** Directory with the catalog that ships with Sling: catalog.json and its packages. */
  SLING_INCLUDED_EXTENSIONS: z.string().min(1).optional(),
  /** Where installed extension packages are unpacked for their processes. */
  SLING_EXTENSION_CACHE: z.string().min(1).optional(),
  /** GitHub repo, as owner/name, whose releases Sling gets sling-runner builds from. */
  SLING_RELEASE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "SLING_RELEASE_REPO must look like owner/name")
    .optional(),
  /** Where sling-runner builds are kept once Sling has fetched them. */
  SLING_RUNNER_CACHE: z.string().min(1).optional(),
});

export interface Config {
  sourceStorageBytes?: number;
  webhookSecret?: string;
  /** Bearer token that unlocks `/metrics`. Without it the endpoint doesn't exist. */
  metricsToken?: string;
  webhookRequestsPerMinute?: number;
  httpAllowedOrigins?: string[];
  trustedProxies?: string[];
  databaseUrl: string;
  publicUrl: URL;
  secretKey: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  /** Longest a stop may take. Defaults to `DEFAULT_SHUTDOWN_MS`. */
  shutdownTimeoutMs?: number;
  webDist: string | undefined;
  /** Image sandboxes run when their provider doesn't name one. Defaults to `sling-sandbox:latest`. */
  sandboxImage?: string | undefined;
  /** GitHub repo whose releases carry sling-runner builds. Defaults to OMouta/sling. */
  releaseRepo?: string | undefined;
  /** Where fetched sling-runner builds are kept. Defaults to `<tmpdir>/sling-runner-builds`. */
  runnerCacheDir?: string | undefined;
  /** Unsigned extension packages may be installed. Only the server's environment sets it. */
  allowUnsignedExtensions?: boolean;
  /** Catalog that ships with Sling. Defaults to the repo's `extensions/dist`. */
  includedExtensionsDir?: string | undefined;
  /** Where packages are unpacked. Defaults to `<tmpdir>/sling-extensions`. */
  extensionCacheDir?: string | undefined;
  /** Only set by tests. */
  testing?: {
    /** Passed to sandboxes as SLING_CODEX_BIN, so they run a fake Codex. */
    sandboxCodexBin?: string;
    /** Passed to sandboxes as SLING_CLAUDE_BIN. */
    sandboxClaudeBin?: string;
    /** Allows `file://` URLs and local paths as sandbox clone URLs. */
    allowLocalCloneUrls?: boolean;
    /** Origins accepted as push endpoints besides the known push services, such as a local stand-in. */
    pushOrigins?: string[];
    /** Where sandbox PRs are merged through GitHub's REST API, in place of api.github.com. */
    githubApiUrl?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    sourceStorageBytes: e.SLING_SOURCE_STORAGE_BYTES,
    webhookSecret: e.SLING_WEBHOOK_SECRET,
    metricsToken: e.SLING_METRICS_TOKEN,
    webhookRequestsPerMinute: e.SLING_WEBHOOK_REQUESTS_PER_MINUTE,
    httpAllowedOrigins: e.SLING_HTTP_ALLOWED_ORIGINS.split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => new URL(v).origin),
    trustedProxies: e.SLING_TRUSTED_PROXIES.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    databaseUrl: e.DATABASE_URL,
    publicUrl: new URL(e.SLING_PUBLIC_URL),
    secretKey: e.SLING_SECRET_KEY,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    shutdownTimeoutMs: e.SLING_SHUTDOWN_TIMEOUT_SECONDS * 1000,
    webDist: e.SLING_WEB_DIST,
    sandboxImage: e.SLING_SANDBOX_IMAGE,
    releaseRepo: e.SLING_RELEASE_REPO,
    runnerCacheDir: e.SLING_RUNNER_CACHE,
    allowUnsignedExtensions: e.SLING_ALLOW_UNSIGNED_EXTENSIONS,
    includedExtensionsDir: e.SLING_INCLUDED_EXTENSIONS,
    extensionCacheDir: e.SLING_EXTENSION_CACHE,
  };
}
