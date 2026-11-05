import { newId } from "@sling/core";
import { type Db, schema } from "@sling/db";
import { type Installation, NodeError } from "@sling/workflow";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../../context.ts";
import { decryptSecret, encryptSecret, SECRET_KEY_VERSION } from "../../crypto.ts";
import { secretStrings } from "../redact.ts";
import type { InstallationRow } from "../views.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Decrypts an installation's credentials. Empty when none are stored. */
export async function readCredentials(
  ctx: Pick<AppContext, "db" | "secretsKey">,
  row: InstallationRow,
): Promise<Record<string, unknown>> {
  if (!row.credentialId) return {};
  const [cred] = await ctx.db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.id, row.credentialId),
        eq(schema.credentials.workspaceId, row.workspaceId),
        eq(schema.credentials.kind, "connector"),
      ),
    );
  if (!cred) return {};
  return JSON.parse(decryptSecret(ctx.secretsKey, cred.ciphertext)) as Record<string, unknown>;
}

/** Stores credentials encrypted, replacing the existing blob if there is one. Returns its ID. */
export async function writeCredentials(
  ctx: Pick<AppContext, "secretsKey">,
  tx: Tx,
  owner: { workspaceId: string; ownerId: string },
  credentialId: string | null,
  value: Record<string, unknown>,
): Promise<string> {
  const ciphertext = encryptSecret(ctx.secretsKey, JSON.stringify(value));
  if (credentialId) {
    await tx
      .update(schema.credentials)
      .set({ ciphertext, keyVersion: SECRET_KEY_VERSION })
      .where(
        and(
          eq(schema.credentials.id, credentialId),
          eq(schema.credentials.workspaceId, owner.workspaceId),
        ),
      );
    return credentialId;
  }
  const id = newId("crd");
  await tx.insert(schema.credentials).values({
    id,
    workspaceId: owner.workspaceId,
    ownerId: owner.ownerId,
    kind: "connector",
    ciphertext,
    keyVersion: SECRET_KEY_VERSION,
  });
  return id;
}

/**
 * An installation as a node sees it, scoped to the run's workspace, plus the
 * secret values to scrub from anything the node stores.
 */
export async function loadInstallation(
  ctx: AppContext,
  workspaceId: string,
  id: string,
): Promise<{ installation: Installation; secrets: string[] }> {
  const [row] = await ctx.db
    .select()
    .from(schema.connectorInstallations)
    .where(
      and(
        eq(schema.connectorInstallations.id, id),
        eq(schema.connectorInstallations.workspaceId, workspaceId),
      ),
    );
  if (!row)
    throw new NodeError(`No installation ${id} in this workspace`, { code: "no_installation" });
  if (!row.enabled) {
    throw new NodeError(`The installation ${row.name} is disabled`, {
      code: "installation_disabled",
    });
  }
  const credentials = await readCredentials(ctx, row);
  const connector = ctx.registry.connector(row.connectorId);
  const secretFields = connector?.secretFields ?? Object.keys(credentials);
  return {
    installation: {
      id: row.id,
      connectorId: row.connectorId,
      name: row.name,
      credentials,
      config: row.config,
    },
    secrets: [...secretStrings(credentials, secretFields)],
  };
}

/** The workspace owner, who external approvals are decided on behalf of. */
export async function workspaceOwner(ctx: Pick<AppContext, "db">, workspaceId: string) {
  const [m] = await ctx.db
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.role, "owner"),
      ),
    )
    .limit(1);
  return m?.userId ?? null;
}
