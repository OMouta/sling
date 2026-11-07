import { createHash, randomBytes } from "node:crypto";
import { newId, type OAuthConnectionView } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import {
  decryptSecret,
  encryptSecret,
  SECRET_KEY_VERSION,
  safeEqual,
  sha256Hex,
} from "../crypto.ts";
import type { Actor } from "../http/session.ts";
import { readCredentials } from "../workflows/connectors/installations.ts";
import { ownedInstallation } from "../workflows/connectors/manage.ts";
import {
  type OAuthProvider,
  PROVIDER_ENDPOINTS,
  type ProviderEndpoints,
  redirectUrl,
  signInOf,
} from "./providers.ts";

export { OAUTH_PROVIDERS, type OAuthProvider } from "./providers.ts";

/** An OAuth step that can't go ahead, with the status to answer. */
export class OAuthError extends Error {
  readonly status: number;
  /** The installation it was for, when that's known, so the page can show it there. */
  readonly installationId: string | undefined;
  constructor(message: string, status = 400, installationId?: string) {
    super(message);
    this.status = status;
    this.installationId = installationId;
  }
}

export const OAuthStartQuery = z.object({ installationId: z.string().min(1).max(100) });
export const OAuthCallbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

export interface OAuthStatus {
  connected: boolean;
  scopes: string[];
  /** When the stored access token expires. It's refreshed before then. */
  expiresAt: string | null;
}

export interface OAuthService {
  /**
   * The provider's consent page for one installation, with PKCE and a state
   * bound to the browser session that asked.
   */
  startUrl(
    actor: Actor,
    sessionId: string,
    provider: OAuthProvider,
    installationId: string,
  ): Promise<string>;
  /**
   * Finishes a consent from the provider's redirect: checks the state against
   * the session, swaps the code for tokens, stores them encrypted, and audits
   * `oauth.connected`. Throws OAuthError when it can't.
   */
  callback(
    sessionId: string,
    provider: OAuthProvider,
    query: z.infer<typeof OAuthCallbackQuery>,
  ): Promise<{ workspaceId: string; installationId: string }>;
  /** A live access token, refreshed when it expires within a minute. Throws OAuthError when it can't. */
  accessToken(workspaceId: string, installationId: string): Promise<string>;
  status(workspaceId: string, installationId: string): Promise<OAuthStatus>;
  /** Every installation in the workspace that's signed in. */
  connections(workspaceId: string): Promise<OAuthConnectionView[]>;
  /** Forgets the installation's tokens. */
  disconnect(workspaceId: string, installationId: string): Promise<void>;
}

/** How long a consent may take, from Connect to the provider's redirect. */
const FLOW_TTL_MS = 10 * 60_000;
/** An access token this close to expiring is refreshed first. */
const REFRESH_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;

interface TokenAnswer {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** A token endpoint's refusal, with OAuth's error code. */
class TokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * OAuth for connectors that sign in with the person's own client. The
 * provider's endpoints are fixed; tests point `endpoints` at a stand-in.
 */
export class OAuth implements OAuthService {
  readonly #ctx: AppContext;
  /** In-flight refreshes, so concurrent calls for one installation share one. */
  readonly #refreshing = new Map<string, Promise<string>>();
  endpoints: Record<OAuthProvider, ProviderEndpoints> = structuredClone(PROVIDER_ENDPOINTS);

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async startUrl(
    actor: Actor,
    sessionId: string,
    provider: OAuthProvider,
    installationId: string,
  ): Promise<string> {
    const ctx = this.#ctx;
    const row = await ownedInstallation(ctx, actor.workspaceId, installationId);
    if (!row) throw new OAuthError("That account isn't in this workspace.", 404);
    const use = signInOf(ctx.registry.connector(row.connectorId), row.config);
    const endpoints = this.endpoints[provider];
    if (!use || use.provider !== provider) {
      throw new OAuthError(`${row.name} doesn't sign in with ${endpoints.name}.`, 400, row.id);
    }
    if (!sessionId) throw new OAuthError("Sign in to Sling again, then connect.", 401, row.id);
    const credentials = await readCredentials(ctx, row);
    const clientId = text(credentials.clientId);
    if (!clientId || !text(credentials.clientSecret)) {
      throw new OAuthError(`Add the OAuth client ID and secret to ${row.name} first.`, 400, row.id);
    }

    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const now = Date.now();
    await ctx.db.delete(schema.oauthFlows).where(lt(schema.oauthFlows.expiresAt, new Date(now)));
    await ctx.db.insert(schema.oauthFlows).values({
      id: sha256Hex(state),
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      installationId: row.id,
      provider,
      codeVerifier: encryptSecret(ctx.secretsKey, verifier),
      keyVersion: SECRET_KEY_VERSION,
      sessionHash: sha256Hex(sessionId),
      expiresAt: new Date(now + FLOW_TTL_MS),
    });
    const url = new URL(endpoints.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUrl(ctx.config.publicUrl, provider),
      response_type: "code",
      scope: use.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...endpoints.consentParams,
    }).toString();
    return url.href;
  }

  async callback(
    sessionId: string,
    provider: OAuthProvider,
    query: z.infer<typeof OAuthCallbackQuery>,
  ): Promise<{ workspaceId: string; installationId: string }> {
    const ctx = this.#ctx;
    const name = this.endpoints[provider].name;
    const again = "Start again from Connect.";
    if (!query.state)
      throw new OAuthError(`${name} sent the browser back without its state. ${again}`);
    // Taken out as it's read, so a state works once.
    const [flow] = await ctx.db
      .delete(schema.oauthFlows)
      .where(eq(schema.oauthFlows.id, sha256Hex(query.state)))
      .returning();
    if (!flow || flow.provider !== provider) {
      throw new OAuthError(
        `This sign-in was already used, or it isn't one Sling started. ${again}`,
      );
    }
    const installationId = flow.installationId;
    if (flow.expiresAt.getTime() < Date.now()) {
      throw new OAuthError(
        `The sign-in took longer than 10 minutes. ${again}`,
        400,
        installationId,
      );
    }
    if (!sessionId || !safeEqual(flow.sessionHash, sha256Hex(sessionId))) {
      throw new OAuthError(
        `This sign-in was started in another browser session. ${again}`,
        400,
        installationId,
      );
    }
    if (query.error) {
      throw new OAuthError(
        query.error === "access_denied"
          ? `${name} sign-in was canceled.`
          : `${name} didn't sign in: ${query.error}.`,
        400,
        installationId,
      );
    }
    if (!query.code) {
      throw new OAuthError(
        `${name} sent the browser back without a code. ${again}`,
        400,
        installationId,
      );
    }
    const row = await ownedInstallation(ctx, flow.workspaceId, installationId);
    if (!row) throw new OAuthError("That account was deleted while signing in.", 404);
    const use = signInOf(ctx.registry.connector(row.connectorId), row.config);
    if (!use || use.provider !== provider) {
      throw new OAuthError(`${row.name} doesn't sign in with ${name} any more.`, 400, row.id);
    }
    const client = await this.#client(row);
    let answer: TokenAnswer;
    try {
      answer = await this.#token(provider, {
        grant_type: "authorization_code",
        code: query.code,
        redirect_uri: redirectUrl(ctx.config.publicUrl, provider),
        client_id: client.id,
        client_secret: client.secret,
        code_verifier: decryptSecret(ctx.secretsKey, flow.codeVerifier),
      });
    } catch (err) {
      throw new OAuthError(this.#explain(provider, err, row.name), 400, row.id);
    }
    if (!answer.refresh_token) {
      throw new OAuthError(
        `${name} didn't send a refresh token, so Sling couldn't stay signed in. Remove Sling's access from your ${name} account, then connect again.`,
        400,
        row.id,
      );
    }
    const scopes = (answer.scope ?? use.scopes.join(" ")).split(/\s+/).filter(Boolean);
    const values = {
      workspaceId: row.workspaceId,
      ownerId: flow.userId,
      installationId: row.id,
      provider,
      refreshToken: encryptSecret(ctx.secretsKey, answer.refresh_token),
      accessToken: encryptSecret(ctx.secretsKey, answer.access_token),
      keyVersion: SECRET_KEY_VERSION,
      expiresAt: this.#expiry(answer),
      scopes,
    };
    await ctx.db
      .insert(schema.oauthTokens)
      .values({ id: newId("oat"), ...values })
      .onConflictDoUpdate({
        target: schema.oauthTokens.installationId,
        set: { ...values, updatedAt: new Date() },
      });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actorType: "user",
      actorId: flow.userId,
      verb: "oauth.connected",
      subjectType: "installation",
      subjectId: row.id,
      details: { provider, connectorId: row.connectorId, name: row.name, scopes },
    });
    return { workspaceId: row.workspaceId, installationId: row.id };
  }

  async accessToken(workspaceId: string, installationId: string): Promise<string> {
    const token = await this.#tokenRow(workspaceId, installationId);
    if (!token) {
      throw new OAuthError(
        "Not connected yet. Connect it on the Connectors page.",
        409,
        installationId,
      );
    }
    const fresh =
      token.accessToken &&
      token.expiresAt &&
      token.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
    if (fresh && token.accessToken) return decryptSecret(this.#ctx.secretsKey, token.accessToken);
    const running = this.#refreshing.get(installationId);
    if (running) return running;
    const refresh = this.#refresh(token).finally(() => this.#refreshing.delete(installationId));
    this.#refreshing.set(installationId, refresh);
    return refresh;
  }

  async status(workspaceId: string, installationId: string): Promise<OAuthStatus> {
    const token = await this.#tokenRow(workspaceId, installationId);
    return {
      connected: token !== null,
      scopes: token?.scopes ?? [],
      expiresAt: token?.expiresAt?.toISOString() ?? null,
    };
  }

  async connections(workspaceId: string): Promise<OAuthConnectionView[]> {
    const rows = await this.#ctx.db
      .select()
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.workspaceId, workspaceId));
    return rows.map((r) => ({
      installationId: r.installationId,
      provider: r.provider,
      scopes: r.scopes,
      connectedAt: r.createdAt.toISOString(),
    }));
  }

  async disconnect(workspaceId: string, installationId: string): Promise<void> {
    const [token] = await this.#ctx.db
      .delete(schema.oauthTokens)
      .where(
        and(
          eq(schema.oauthTokens.workspaceId, workspaceId),
          eq(schema.oauthTokens.installationId, installationId),
        ),
      )
      .returning();
    if (!token) return;
    const provider = token.provider as OAuthProvider;
    const endpoints = this.endpoints[provider];
    if (!endpoints) return;
    try {
      // The provider forgets the grant too. A failure here leaves nothing usable on Sling's side.
      await fetch(endpoints.revokeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: decryptSecret(this.#ctx.secretsKey, token.refreshToken),
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      this.#ctx.log.warn({ err, installationId }, "revoking an OAuth token failed");
    }
  }

  async #tokenRow(workspaceId: string, installationId: string) {
    const [row] = await this.#ctx.db
      .select()
      .from(schema.oauthTokens)
      .where(
        and(
          eq(schema.oauthTokens.workspaceId, workspaceId),
          eq(schema.oauthTokens.installationId, installationId),
        ),
      );
    return row ?? null;
  }

  async #client(
    row: Parameters<typeof readCredentials>[1],
  ): Promise<{ id: string; secret: string }> {
    const credentials = await readCredentials(this.#ctx, row);
    const id = text(credentials.clientId);
    const secret = text(credentials.clientSecret);
    if (!id || !secret) {
      throw new OAuthError(`${row.name} has no OAuth client ID and secret.`, 409, row.id);
    }
    return { id, secret };
  }

  async #refresh(token: typeof schema.oauthTokens.$inferSelect): Promise<string> {
    const ctx = this.#ctx;
    const provider = token.provider as OAuthProvider;
    const row = await ownedInstallation(ctx, token.workspaceId, token.installationId);
    if (!row) throw new OAuthError("That account was deleted.", 404);
    const client = await this.#client(row);
    let answer: TokenAnswer;
    try {
      answer = await this.#token(provider, {
        grant_type: "refresh_token",
        refresh_token: decryptSecret(ctx.secretsKey, token.refreshToken),
        client_id: client.id,
        client_secret: client.secret,
      });
    } catch (err) {
      if (
        err instanceof TokenError &&
        (err.code === "invalid_grant" || err.code === "unauthorized_client")
      ) {
        // The grant is gone for good: revoked, expired, or for another client. Only a new sign-in helps.
        await ctx.db.delete(schema.oauthTokens).where(eq(schema.oauthTokens.id, token.id));
        throw new OAuthError(
          `${this.endpoints[provider].name} no longer accepts Sling's sign-in for ${row.name}. Connect it again on the Connectors page.`,
          409,
          row.id,
        );
      }
      throw new OAuthError(this.#explain(provider, err, row.name), 502, row.id);
    }
    await ctx.db
      .update(schema.oauthTokens)
      .set({
        accessToken: encryptSecret(ctx.secretsKey, answer.access_token),
        expiresAt: this.#expiry(answer),
        keyVersion: SECRET_KEY_VERSION,
        // Most providers keep the refresh token; some send a new one each time.
        ...(answer.refresh_token
          ? { refreshToken: encryptSecret(ctx.secretsKey, answer.refresh_token) }
          : {}),
        ...(answer.scope ? { scopes: answer.scope.split(/\s+/).filter(Boolean) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.oauthTokens.id, token.id));
    return answer.access_token;
  }

  #expiry(answer: TokenAnswer): Date {
    const seconds = Number(answer.expires_in);
    // Without a lifetime, assume the usual hour.
    return new Date(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
  }

  async #token(provider: OAuthProvider, form: Record<string, string>): Promise<TokenAnswer> {
    const res = await fetch(this.endpoints[provider].tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body || typeof body.access_token !== "string") {
      const code = text(body?.error) || `http_${res.status}`;
      const detail = text(body?.error_description);
      throw new TokenError(code, detail || code);
    }
    return body as unknown as TokenAnswer;
  }

  /** A token endpoint's refusal, said so the person knows what to change. */
  #explain(provider: OAuthProvider, err: unknown, installation: string): string {
    const name = this.endpoints[provider].name;
    if (err instanceof TokenError) {
      if (err.code === "invalid_client") {
        return `${name} doesn't accept the client ID and secret on ${installation}. Check them on the installation.`;
      }
      if (err.code === "redirect_uri_mismatch") {
        return `Add ${redirectUrl(this.#ctx.config.publicUrl, provider)} to the OAuth client's redirect URIs.`;
      }
      if (err.code === "invalid_grant") {
        return `${name} didn't take the sign-in code. Start again from Connect.`;
      }
      return `${name} refused: ${err.message}`;
    }
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return `${name} didn't answer in time. Try again.`;
    }
    return `Couldn't reach ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
