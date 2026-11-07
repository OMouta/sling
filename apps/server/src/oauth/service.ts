import { z } from "zod";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";

/** An OAuth step that can't go ahead, with the status to answer. */
export class OAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Providers Sling knows the endpoints of. The client ID and secret are the user's own. */
export const OAUTH_PROVIDERS = ["google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

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
  /** Forgets the installation's tokens. */
  disconnect(workspaceId: string, installationId: string): Promise<void>;
}

/** OAuth for connectors that sign in with the user's own client. Until it's built nothing connects. */
export class OAuth implements OAuthService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async startUrl(): Promise<string> {
    void this.#ctx;
    throw new OAuthError("Signing in with OAuth isn't available on this server yet.", 501);
  }

  async callback(): Promise<{ workspaceId: string; installationId: string }> {
    throw new OAuthError("Signing in with OAuth isn't available on this server yet.", 501);
  }

  async accessToken(): Promise<string> {
    throw new OAuthError("This account isn't connected.", 409);
  }

  async status(): Promise<OAuthStatus> {
    return { connected: false, scopes: [], expiresAt: null };
  }

  async disconnect(): Promise<void> {}
}
