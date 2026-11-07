/**
 * The OAuth providers Sling knows, and how a built-in connector says it
 * signs in with one. The client is always the person's own: its ID and
 * secret are the installation's `clientId` and `clientSecret` credentials.
 */
import type { AnyConnector } from "@sling/connector-sdk";
import type { ConnectorSignInView } from "@sling/core";

export const OAUTH_PROVIDERS = ["google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface ProviderEndpoints {
  /** Such as "Google", for messages. */
  name: string;
  /** Where the browser goes to consent. */
  authorizeUrl: string;
  /** Where a code or a refresh token is swapped for an access token. */
  tokenUrl: string;
  /** Where a refresh token is revoked. */
  revokeUrl: string;
  /** Extra parameters on the consent page's address. */
  consentParams: Record<string, string>;
}

export const PROVIDER_ENDPOINTS: Record<OAuthProvider, ProviderEndpoints> = {
  google: {
    name: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    // Google sends a refresh token only for offline access, and on a repeat
    // consent only when it asks again.
    consentParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
};

/** Credential keys that hold the person's OAuth client. */
export const CLIENT_FIELDS = ["clientId", "clientSecret"] as const;

/**
 * What a built-in connector that signs in with OAuth carries next to its
 * definition, as `oauth`.
 */
export interface OAuthSignIn {
  provider: OAuthProvider;
  scopes: string[];
  /** Only installations whose config has these values sign in, such as `{ kind: "google" }`. */
  when?: Record<string, string>;
}

/** The connector's sign-in, when it has one, whatever the installation's config. */
export function declaredSignIn(connector: AnyConnector | undefined): OAuthSignIn | null {
  const use = (connector as { oauth?: Partial<OAuthSignIn> } | undefined)?.oauth;
  if (!use?.provider || !(OAUTH_PROVIDERS as readonly string[]).includes(use.provider)) return null;
  if (!Array.isArray(use.scopes) || use.scopes.length === 0) return null;
  return { provider: use.provider, scopes: use.scopes, when: use.when ?? {} };
}

/** The sign-in an installation with this config uses, or null when it doesn't sign in. */
export function signInOf(connector: AnyConnector | undefined, config: unknown): OAuthSignIn | null {
  const use = declaredSignIn(connector);
  if (!use) return null;
  const values = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(use.when ?? {})) {
    if (values[key] !== value) return null;
  }
  return use;
}

/** How the web app learns that adding one ends on a consent page. */
export function signInView(connector: AnyConnector): ConnectorSignInView | null {
  const use = declaredSignIn(connector);
  if (!use) return null;
  return {
    provider: use.provider,
    providerName: PROVIDER_ENDPOINTS[use.provider].name,
    when: use.when ?? {},
    fields: [...CLIENT_FIELDS],
  };
}

/** Where the provider sends the browser back. It's the one to add to the OAuth client. */
export function redirectUrl(publicUrl: URL, provider: OAuthProvider): string {
  return new URL(`/api/oauth/${provider}/callback`, publicUrl).href;
}
