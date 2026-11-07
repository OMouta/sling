/**
 * Connectors whose accounts sign in with OAuth, such as Google Calendar:
 * whether an installation does, whether it's connected, and where Connect
 * sends the browser.
 */
import type { ConnectorSignInView, ConnectorView, OAuthConnectionView } from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export const oauthConnectionsKey = ["oauth-connections"] as const;

/** The connector's sign-in, when an installation with this config uses it. */
export function signInFor(
  connector: Pick<ConnectorView, "signIn"> | undefined,
  config: Record<string, unknown>,
): ConnectorSignInView | null {
  const s = connector?.signIn;
  if (!s) return null;
  return Object.entries(s.when).every(([k, v]) => config[k] === v) ? s : null;
}

/** The provider's consent page, by way of the server, for one installation. */
export function connectUrl(signIn: ConnectorSignInView, installationId: string): string {
  return `/api/oauth/${signIn.provider}/start?${new URLSearchParams({ installationId })}`;
}

/** Installations that are signed in. Only asked for when a connector signs in at all. */
export function useOAuthConnections(enabled: boolean) {
  return useQuery({
    queryKey: oauthConnectionsKey,
    queryFn: () => api.get<OAuthConnectionView[]>("/api/oauth/connections"),
    enabled,
  });
}

/** What the server said on the way back from a consent page, from the Connectors URL. */
export interface SignInReturn {
  outcome: "connected" | "failed";
  installationId: string | null;
  error: string | null;
}

export function signInReturn(search: Record<string, unknown>): SignInReturn | null {
  const outcome = search.oauth;
  if (outcome !== "connected" && outcome !== "failed") return null;
  return {
    outcome,
    installationId: typeof search.installation === "string" ? search.installation : null,
    error: typeof search.error === "string" ? search.error : null,
  };
}
