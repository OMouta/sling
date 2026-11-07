import type { AnyConnector, SetupResult } from "@sling/connector-sdk";
import { z } from "zod";

/**
 * What the server adds to the context of a setup lookup and a connection
 * test: the workspace they run for, so a built-in connector can offer its
 * machines. Extension code never gets it.
 */
export interface HostContext {
  workspaceId: string;
}

/** The workspace a lookup or test runs for, when the server said. */
export function hostOf(ctx: object): HostContext | null {
  const id = (ctx as Partial<HostContext>).workspaceId;
  return typeof id === "string" && id ? { workspaceId: id } : null;
}

/** How long a setup lookup may take before the form gives up on it. */
export const SETUP_TIMEOUT_MS = 15_000;

const Note = z.object({
  field: z.string().max(200).optional(),
  tone: z.enum(["info", "ok", "warn", "error"]),
  text: z.string().max(500),
  link: z.object({ label: z.string().max(80), url: z.url().max(2_000) }).optional(),
});

const Option = z.object({
  value: z.string().max(500),
  label: z.string().max(200),
  detail: z.string().max(200).optional(),
});

/** What a setup lookup may hand back, checked because extensions run their own code. */
export const SetupResultSchema = z.object({
  credentials: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  options: z.record(z.string(), z.array(Option).max(500)).optional(),
  name: z.string().trim().max(120).optional(),
  notes: z.array(Note).max(20).optional(),
  reveal: z.array(z.string().max(200)).max(100).optional(),
  retryAfterMs: z.number().int().min(2_000).max(60_000).optional(),
});

export function parseSetupResult(value: unknown): SetupResult {
  const r = SetupResultSchema.safeParse(value ?? {});
  if (!r.success) {
    return {
      notes: [
        { tone: "error", text: "The connector's setup lookup returned something unreadable" },
      ],
    };
  }
  return r.data as SetupResult;
}

/**
 * Runs a connector's setup lookup on what's been typed so far. Never throws:
 * a failed lookup comes back as a note, and the form still works without it.
 */
export async function runSetup(
  connector: AnyConnector,
  input: {
    credentials: Record<string, unknown>;
    config: Record<string, unknown>;
    log: { info(m: string): void; warn(m: string): void; error(m: string): void };
    workspaceId: string;
  },
): Promise<SetupResult> {
  if (!connector.setup) return {};
  try {
    const lookup = {
      credentials: input.credentials,
      config: input.config,
      log: input.log,
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
      workspaceId: input.workspaceId,
    };
    const out = await connector.setup(lookup);
    return parseSetupResult(out);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { notes: [{ tone: "error", text: text.slice(0, 500) }] };
  }
}
