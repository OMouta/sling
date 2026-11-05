import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";

/** How long after signing in turning two-factor on or off needs no password. */
export const FRESH_SIGN_IN_MS = 10 * 60_000;

const ISSUER = "Sling";

/** Backup codes in Better Auth's own format: ten `xxxxx-xxxxx` codes. */
function backupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const code = generateRandomString(10, "a-z", "0-9", "A-Z");
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

function assertFresh(createdAt: Date | string) {
  if (Date.now() - new Date(createdAt).getTime() > FRESH_SIGN_IN_MS) {
    throw new APIError("FORBIDDEN", {
      message: "Confirm it's you first.",
      code: "REAUTH_REQUIRED",
    });
  }
}

/**
 * Turning on an authenticator app without retyping the password, right after
 * signing in. Better Auth's own endpoints always ask for the password; these
 * ask for a recent sign-in instead, the way GitHub's sudo mode does. The
 * secret and backup codes are stored exactly as the two-factor plugin stores
 * them, so its verify and sign-in endpoints work unchanged.
 */
export function freshTwoFactor() {
  return {
    id: "sling-fresh-two-factor",
    endpoints: {
      enableTwoFactorFresh: createAuthEndpoint(
        "/two-factor/enable-fresh",
        { method: "POST", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          assertFresh(session.createdAt);
          if ((user as { twoFactorEnabled?: boolean }).twoFactorEnabled) {
            throw new APIError("BAD_REQUEST", { message: "Two-factor is already on." });
          }
          const key = ctx.context.secretConfig;
          const codes = backupCodes();
          const secret = generateRandomString(32);
          const data = {
            secret: await symmetricEncrypt({ key, data: secret }),
            backupCodes: await symmetricEncrypt({ key, data: JSON.stringify(codes) }),
            verified: false,
          };
          const existing = await ctx.context.adapter.findOne<{ id: string }>({
            model: "twoFactor",
            where: [{ field: "userId", value: user.id }],
          });
          if (existing) {
            await ctx.context.adapter.update({
              model: "twoFactor",
              update: data,
              where: [{ field: "id", value: existing.id }],
            });
          } else {
            await ctx.context.adapter.create({
              model: "twoFactor",
              data: { ...data, userId: user.id },
            });
          }
          const totpURI = createOTP(secret, { digits: 6, period: 30 }).url(ISSUER, user.email);
          return ctx.json({ totpURI, backupCodes: codes });
        },
      ),
      disableTwoFactorFresh: createAuthEndpoint(
        "/two-factor/disable-fresh",
        { method: "POST", use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          assertFresh(session.createdAt);
          await ctx.context.internalAdapter.updateUser(user.id, { twoFactorEnabled: false });
          await ctx.context.adapter.delete({
            model: "twoFactor",
            where: [{ field: "userId", value: user.id }],
          });
          return ctx.json({ ok: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
