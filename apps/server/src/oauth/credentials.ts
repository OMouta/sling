import type { AppContext } from "../context.ts";
import { redirectUrl, signInOf } from "./providers.ts";

/** What Sling fills in, never what was stored or typed. */
const FILLED = ["accessToken", "signIn"] as const;

/**
 * Credentials as a connector that signs in with OAuth sees them: what's
 * stored, plus `accessToken`, live and refreshed, once the installation is
 * signed in, and `signIn` with the redirect URL to add to the client and why
 * there's no token yet. Other connectors get theirs unchanged.
 */
export async function withSignIn(
  ctx: Pick<AppContext, "registry" | "oauth" | "config">,
  installation: {
    /** Missing while the installation is still being added. */
    id?: string;
    workspaceId: string;
    connectorId: string;
    config: unknown;
  },
  credentials: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const use = signInOf(ctx.registry.connector(installation.connectorId), installation.config);
  if (!use) return credentials;
  const out = { ...credentials };
  for (const key of FILLED) delete out[key];
  const signIn = { redirectUrl: redirectUrl(ctx.config.publicUrl, use.provider), problem: null };
  if (!installation.id) return { ...out, signIn };
  try {
    const accessToken = await ctx.oauth.accessToken(installation.workspaceId, installation.id);
    return { ...out, accessToken, signIn };
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    return { ...out, signIn: { ...signIn, problem } };
  }
}
