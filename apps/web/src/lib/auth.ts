import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    passkeyClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        // Keep the page to open after signing in.
        const next = new URLSearchParams(window.location.search).get("next");
        const search = new URLSearchParams(next ? { step: "2fa", next } : { step: "2fa" });
        window.location.assign(`/login?${search}`);
      },
    }),
  ],
});
