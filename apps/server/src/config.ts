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
});

export interface Config {
  databaseUrl: string;
  publicUrl: URL;
  secretKey: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  webDist: string | undefined;
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
  };
}
