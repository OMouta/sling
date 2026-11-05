// Only used by `pnpm auth:schema` to generate packages/db/src/schema/auth.ts.
// Keep the plugin list in sync with src/auth/auth.ts.
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: "pg", usePlural: true }),
  emailAndPassword: { enabled: true },
  plugins: [twoFactor(), passkey()],
});
