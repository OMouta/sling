import {
  DEFAULT_HARNESS,
  type Harness,
  isHarness,
  newId,
  type SandboxSettingsView,
} from "@sling/core";
import { type CredentialKind, type Db, type SandboxSettings, schema } from "@sling/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { decryptSecret, encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";
import { sandboxMinutes } from "../views.ts";

export const SANDBOX_DEFAULTS = {
  concurrentLimit: 2,
  lifetimeMinutes: 60,
  monthlyMinutesBudget: 600,
} as const;

export interface ResolvedSandboxSettings {
  concurrentLimit: number;
  lifetimeMinutes: number;
  monthlyMinutesBudget: number;
  costPerHour: Record<string, number>;
}

export function resolveSettings(raw: SandboxSettings | null | undefined): ResolvedSandboxSettings {
  return {
    concurrentLimit: raw?.concurrentLimit ?? SANDBOX_DEFAULTS.concurrentLimit,
    lifetimeMinutes: raw?.lifetimeMinutes ?? SANDBOX_DEFAULTS.lifetimeMinutes,
    monthlyMinutesBudget: raw?.monthlyMinutesBudget ?? SANDBOX_DEFAULTS.monthlyMinutesBudget,
    costPerHour: raw?.costPerHour ?? {},
  };
}

export async function workspaceSettings(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
): Promise<{ settings: ResolvedSandboxSettings; defaultHarness: Harness }> {
  const [ws] = await ctx.db
    .select({
      sandboxSettings: schema.workspaces.sandboxSettings,
      defaultHarness: schema.workspaces.defaultHarness,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return {
    settings: resolveSettings(ws?.sandboxSettings),
    defaultHarness: isHarness(ws?.defaultHarness) ? ws.defaultHarness : DEFAULT_HARNESS,
  };
}

/** The write-only sandbox secrets, by API name. */
export const SECRET_KINDS = {
  openaiApiKey: "harness_openai",
  anthropicApiKey: "harness_anthropic",
  gitToken: "git_token",
} as const satisfies Record<string, CredentialKind>;
export type SecretName = keyof typeof SECRET_KINDS;
const SECRET_NAMES = Object.keys(SECRET_KINDS) as SecretName[];

export async function secretStatus(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
): Promise<SandboxSettingsView["secrets"]> {
  const rows = await ctx.db
    .select({ kind: schema.credentials.kind })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.workspaceId, workspaceId),
        inArray(schema.credentials.kind, Object.values(SECRET_KINDS)),
      ),
    );
  const kinds = new Set(rows.map((r) => r.kind));
  return {
    openaiApiKey: kinds.has(SECRET_KINDS.openaiApiKey),
    anthropicApiKey: kinds.has(SECRET_KINDS.anthropicApiKey),
    gitToken: kinds.has(SECRET_KINDS.gitToken),
  };
}

/** Decrypted sandbox secrets. Only the ones stored are present. Never log the result. */
export async function readSecrets(
  ctx: Pick<AppContext, "db" | "secretsKey">,
  workspaceId: string,
): Promise<Partial<Record<SecretName, string>>> {
  const rows = await ctx.db
    .select({ kind: schema.credentials.kind, ciphertext: schema.credentials.ciphertext })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.workspaceId, workspaceId),
        inArray(schema.credentials.kind, Object.values(SECRET_KINDS)),
      ),
    );
  const out: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) {
    const row = rows.find((r) => r.kind === SECRET_KINDS[name]);
    if (row) out[name] = decryptSecret(ctx.secretsKey, row.ciphertext);
  }
  return out;
}

/** Stores or clears secrets. An empty string clears; a missing key leaves it alone. */
export async function writeSecrets(
  ctx: Pick<AppContext, "db" | "secretsKey">,
  owner: { workspaceId: string; ownerId: string },
  values: Partial<Record<SecretName, string>>,
): Promise<{ set: SecretName[]; cleared: SecretName[] }> {
  const set: SecretName[] = [];
  const cleared: SecretName[] = [];
  await ctx.db.transaction(async (tx) => {
    for (const name of SECRET_NAMES) {
      const value = values[name];
      if (value === undefined) continue;
      const kind = SECRET_KINDS[name];
      const where = and(
        eq(schema.credentials.workspaceId, owner.workspaceId),
        eq(schema.credentials.kind, kind),
      );
      if (value === "") {
        const gone = await tx
          .delete(schema.credentials)
          .where(where)
          .returning({ id: schema.credentials.id });
        if (gone.length) cleared.push(name);
        continue;
      }
      const ciphertext = encryptSecret(ctx.secretsKey, value);
      const updated = await tx
        .update(schema.credentials)
        .set({ ciphertext, keyVersion: SECRET_KEY_VERSION })
        .where(where)
        .returning({ id: schema.credentials.id });
      if (updated.length === 0) {
        await tx.insert(schema.credentials).values({
          id: newId("crd"),
          workspaceId: owner.workspaceId,
          ownerId: owner.ownerId,
          kind,
          ciphertext,
          keyVersion: SECRET_KEY_VERSION,
        });
      }
      set.push(name);
    }
  });
  return { set, cleared };
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Sandbox minutes this calendar month (UTC), with estimated cost where a cost per hour is set. */
export async function monthUsage(
  db: Db,
  workspaceId: string,
  settings: ResolvedSandboxSettings,
  now: Date = new Date(),
): Promise<{ minutes: number; cost: number | null }> {
  const rows = await db
    .select()
    .from(schema.sandboxes)
    .where(
      and(
        eq(schema.sandboxes.workspaceId, workspaceId),
        gte(schema.sandboxes.requestedAt, monthStart(now)),
      ),
    );
  let minutes = 0;
  let cost = 0;
  for (const s of rows) {
    const m = sandboxMinutes(s, now);
    minutes += m;
    cost += (m / 60) * (settings.costPerHour[s.providerInstallationId] ?? 0);
  }
  const hasCosts = Object.keys(settings.costPerHour).length > 0;
  return {
    minutes: Math.round(minutes * 100) / 100,
    cost: hasCosts ? Math.round(cost * 100) / 100 : null,
  };
}
