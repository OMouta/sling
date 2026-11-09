import { randomBytes } from "node:crypto";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import type { WebhookSecretView, WebhookSigningView } from "@sling/workflow";
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { decryptSecret, encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";

/**
 * How long the secret from before a rotation keeps working, so senders can
 * switch to the new one without dropping requests in between.
 */
export const PREVIOUS_SECRET_MS = 60 * 60 * 1000;

interface Stored {
  current: string;
  previous?: string;
}

type SecretRow = typeof schema.webhookSecrets.$inferSelect;

function view(row: SecretRow, now: number): WebhookSigningView {
  const until = row.previousUntil && row.previousUntil.getTime() > now ? row.previousUntil : null;
  return {
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    previousValidUntil: until?.toISOString() ?? null,
  };
}

async function row(ctx: AppContext, workflowId: string, nodeId: string) {
  const [found] = await ctx.db
    .select()
    .from(schema.webhookSecrets)
    .where(
      and(
        eq(schema.webhookSecrets.workflowId, workflowId),
        eq(schema.webhookSecrets.nodeId, nodeId),
      ),
    );
  return found ?? null;
}

async function stored(ctx: AppContext, found: SecretRow): Promise<Stored | null> {
  const [cred] = await ctx.db
    .select({ ciphertext: schema.credentials.ciphertext })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.id, found.credentialId),
        eq(schema.credentials.workspaceId, found.workspaceId),
        eq(schema.credentials.kind, "webhook_signing"),
      ),
    );
  if (!cred) return null;
  return JSON.parse(decryptSecret(ctx.secretsKey, cred.ciphertext)) as Stored;
}

/** When a trigger's signing secret was made and last rotated, or null when it has none. */
export async function signingStatus(
  ctx: AppContext,
  workflowId: string,
  nodeId: string,
  now = Date.now(),
): Promise<WebhookSigningView | null> {
  const found = await row(ctx, workflowId, nodeId);
  return found ? view(found, now) : null;
}

/** Trigger nodes, out of `nodeIds`, that have a signing secret. */
export async function nodesWithSecrets(
  ctx: AppContext,
  workflowId: string,
  nodeIds: string[],
): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await ctx.db
    .select({ nodeId: schema.webhookSecrets.nodeId })
    .from(schema.webhookSecrets)
    .where(
      and(
        eq(schema.webhookSecrets.workflowId, workflowId),
        inArray(schema.webhookSecrets.nodeId, nodeIds),
      ),
    );
  return new Set(rows.map((r) => r.nodeId));
}

/**
 * The secrets a signed request may use: the current one, and the one before
 * it while its overlap lasts. Empty when the trigger has none.
 */
export async function acceptedSecrets(
  ctx: AppContext,
  workflowId: string,
  nodeId: string,
  now = Date.now(),
): Promise<string[]> {
  const found = await row(ctx, workflowId, nodeId);
  if (!found) return [];
  const secrets = await stored(ctx, found);
  if (!secrets) return [];
  const overlap = found.previousUntil && found.previousUntil.getTime() > now;
  return overlap && secrets.previous ? [secrets.current, secrets.previous] : [secrets.current];
}

/**
 * Makes a trigger's signing secret, or replaces it. A replaced secret keeps
 * working for PREVIOUS_SECRET_MS. The URL token doesn't change. The new
 * secret is returned this once; afterwards only its dates are shown.
 */
export async function rotateSigningSecret(
  ctx: AppContext,
  actor: { userId: string; workspaceId: string },
  workflowId: string,
  nodeId: string,
  now = Date.now(),
): Promise<WebhookSecretView> {
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const result = await ctx.db.transaction(async (tx) => {
    // Serializes rotations of one trigger, so two at once can't both keep the same previous secret.
    const [found] = await tx
      .select()
      .from(schema.webhookSecrets)
      .where(
        and(
          eq(schema.webhookSecrets.workflowId, workflowId),
          eq(schema.webhookSecrets.nodeId, nodeId),
        ),
      )
      .for("update");
    if (!found) {
      const credentialId = newId("crd");
      await tx.insert(schema.credentials).values({
        id: credentialId,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        kind: "webhook_signing",
        ciphertext: encryptSecret(ctx.secretsKey, JSON.stringify({ current: secret })),
        keyVersion: SECRET_KEY_VERSION,
      });
      const [made] = await tx
        .insert(schema.webhookSecrets)
        .values({ workflowId, nodeId, workspaceId: actor.workspaceId, credentialId })
        .returning();
      if (!made) throw new Error("insert failed");
      return { row: made, rotated: false };
    }
    const old = await stored(ctx, found);
    const next: Stored = old ? { current: secret, previous: old.current } : { current: secret };
    await tx
      .update(schema.credentials)
      .set({
        ciphertext: encryptSecret(ctx.secretsKey, JSON.stringify(next)),
        keyVersion: SECRET_KEY_VERSION,
      })
      .where(eq(schema.credentials.id, found.credentialId));
    const [updated] = await tx
      .update(schema.webhookSecrets)
      .set({
        rotatedAt: new Date(now),
        previousUntil: old ? new Date(now + PREVIOUS_SECRET_MS) : null,
      })
      .where(
        and(
          eq(schema.webhookSecrets.workflowId, workflowId),
          eq(schema.webhookSecrets.nodeId, nodeId),
        ),
      )
      .returning();
    if (!updated) throw new Error("update failed");
    return { row: updated, rotated: true };
  });
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: result.rotated ? "workflow.webhook_secret_rotated" : "workflow.webhook_secret_created",
    subjectType: "workflow",
    subjectId: workflowId,
    details: { nodeId },
  });
  return { ...view(result.row, now), secret };
}

/** Drops a workflow's signing secrets, before the workflow itself goes. */
export async function dropSigningSecrets(ctx: AppContext, workflowId: string): Promise<void> {
  const rows = await ctx.db
    .select({ credentialId: schema.webhookSecrets.credentialId })
    .from(schema.webhookSecrets)
    .where(eq(schema.webhookSecrets.workflowId, workflowId));
  if (rows.length === 0) return;
  await ctx.db.delete(schema.credentials).where(
    inArray(
      schema.credentials.id,
      rows.map((r) => r.credentialId),
    ),
  );
}
