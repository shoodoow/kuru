import { config } from "../config.js";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { getDb } from "../db/client.js";
import { account, session, user, verification } from "../db/schema.js";
import { createAccount } from "../roster/roster.js";

type Database = ReturnType<typeof getDb>;

const localWebOrigins = ["http://127.0.0.1:8081", "http://localhost:8081"];

/**
 * Lists browser origins that may call the core while developing.
 * Input: none. Extra origins come from BETTER_AUTH_TRUSTED_ORIGINS.
 * Output: the Expo web origins. Production returns none.
 */
export function localBrowserOrigins(): string[] {
  if (config.isProduction()) {
    return [];
  }
  return [...localWebOrigins, ...config.trustedOrigins()];
}

/**
 * Builds the Google sign-in API for one database.
 * Input: the core database.
 * Output: the Better Auth instance mounted at /api/auth. A new Google user gets one tenant id.
 */
export function createAuth(db: Database) {
  const googleId = config.googleClientId();
  const googleSecret = config.googleClientSecret();
  const baseURL = config.publicUrl();
  if (config.isProduction()) {
    if (!googleId || !googleSecret) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
    }
    if (!baseURL.startsWith("https://")) {
      throw new Error("BETTER_AUTH_URL must use HTTPS in production.");
    }
  }
  const extraOrigins = config.trustedOrigins();
  let publicOrigin: string | undefined;
  try {
    publicOrigin = new URL(baseURL).origin;
  } catch {
    publicOrigin = undefined;
  }
  return betterAuth({
    baseURL,
    advanced: { trustedProxyHeaders: true },
    secret: config.authSecret(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    // Google always shows its account chooser, so "use another account" on the
    // phone can pick a different one instead of silently reusing the last.
    socialProviders: googleId && googleSecret ? { google: { clientId: googleId, clientSecret: googleSecret, prompt: "select_account" } } : {},
    // The Expo browser drops the state cookie set on the redirect to Google. The callback still matches the state stored in the verification table.
    account: {
      skipStateCookieCheck: true,
      // Google tokens from sign-in are stored sealed, like every other secret here.
      encryptOAuthTokens: true,
    },
    plugins: [expo()],
    trustedOrigins: [
      "nano-agents://",
      ...(publicOrigin ? [publicOrigin] : []),
      ...extraOrigins,
      ...(config.isProduction()
        ? []
        : [
            "http://127.0.0.1:8081",
            "http://localhost:8081",
            "exp://",
            "exp://**",
            "exp://192.168.*.*:*/**",
            "exp://192.168.*.*:*/--/**",
          ]),
    ],
    user: {
      additionalFields: {
        accountId: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (created) => {
            const tenant = await createAccount(db, { name: created.name || "Account" }, { email: created.email });
            return { data: { ...created, accountId: tenant.id } };
          },
        },
      },
    },
  });
}
