import { passkey } from "@better-auth/passkey";
import { newId } from "@sling/core";
import { type Db, schema } from "@sling/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { count } from "drizzle-orm";
import type { Config } from "../config.ts";
import { deriveKey } from "../crypto.ts";
import { freshTwoFactor } from "./fresh-two-factor.ts";

export interface AuthHooks {
  /** Called after sign-up creates the user's workspace. */
  onWorkspaceCreated?(workspaceId: string): Promise<void>;
}

/** Carries the client's address to Better Auth, for rate limits and sessions. */
export const CLIENT_IP_HEADER = "x-sling-client-ip";

export function createAuth(db: Db, config: Config, hooks: AuthHooks = {}) {
  const origin = config.publicUrl.origin;
  return betterAuth({
    appName: "Sling",
    baseURL: origin,
    basePath: "/api/auth",
    secret: deriveKey(config.secretKey, "better-auth").toString("base64"),
    trustedOrigins: [origin],
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      twoFactor({ issuer: "Sling" }),
      freshTwoFactor(),
      passkey({ rpID: config.publicUrl.hostname, rpName: "Sling", origin }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Single user for now: only the first-run setup may sign up.
          before: async () => {
            const [row] = await db.select({ n: count() }).from(schema.users);
            if ((row?.n ?? 0) > 0) {
              throw new APIError("FORBIDDEN", { message: "Sling already has an account." });
            }
          },
          after: async (user) => {
            const workspaceId = newId("wsp");
            await db.transaction(async (tx) => {
              await tx.insert(schema.workspaces).values({ id: workspaceId, name: "Home" });
              await tx
                .insert(schema.workspaceMembers)
                .values({ workspaceId, userId: user.id, role: "owner" });
            });
            await hooks.onWorkspaceCreated?.(workspaceId);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
