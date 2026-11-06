import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** URL people's browsers use to reach Sling, for example https://sling.example.com. */
  SLING_PUBLIC_URL: z.url(),
  /** Master secret. Encryption and auth keys are derived from it. */
  SLING_SECRET_KEY: z.string().min(32, "SLING_SECRET_KEY must be at least 32 characters"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
  /** GitHub repo, as owner/name, whose releases the Runner install script downloads. */
  SLING_RELEASE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "SLING_RELEASE_REPO must look like owner/name")
    .optional(),
});

export interface Config {
  databaseUrl: string;
  publicUrl: URL;
  secretKey: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  webDist: string | undefined;
  /** Image sandboxes run when their provider doesn't name one. Defaults to `sling-sandbox:latest`. */
  sandboxImage?: string | undefined;
  /** GitHub repo the Runner install script downloads releases from. */
  releaseRepo?: string | undefined;
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
    databaseUrl: e.DATABASE_URL,
    publicUrl: new URL(e.SLING_PUBLIC_URL),
    secretKey: e.SLING_SECRET_KEY,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    webDist: e.SLING_WEB_DIST,
    sandboxImage: e.SLING_SANDBOX_IMAGE,
    releaseRepo: e.SLING_RELEASE_REPO,
    allowUnsignedExtensions: e.SLING_ALLOW_UNSIGNED_EXTENSIONS,
    includedExtensionsDir: e.SLING_INCLUDED_EXTENSIONS,
    extensionCacheDir: e.SLING_EXTENSION_CACHE,
  };
}
