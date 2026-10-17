import { config } from "../config.js";
import type { getDb } from "../db/client.js";
import { catalogPlugin } from "./catalog.js";
import { codeChallenge, codeVerifier, pluginCallbackUrl, savePending, takePending } from "./oauth-pending.js";
import { and, eq } from "drizzle-orm";
import { mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { applyGoogleConnection, googleRefreshToken } from "./plugins.js";

type Database = ReturnType<typeof getDb>;

/**
 * Starts Google consent for one featured plugin.
 * Why: Gmail, Calendar, and Drive are not MCP servers. The phone opens Google, and the refresh token is stored for this plugin only.
 * Only this plugin's scopes are asked for, and the person picks the Google account each time, so YouTube
 * can go to a brand account while Gmail stays on a personal one.
 * Input: database, account id, plugin id. Output: an authorize URL.
 */
export async function startGoogleOAuth(
  db: Database,
  accountId: string,
  pluginId: string,
): Promise<{ installed: false; url: string }> {
  const plugin = catalogPlugin(pluginId);
  // Instagram and TikTok are connected by an agent in chat, not from the Plugins page.
  if (!plugin || plugin.provider !== "google") throw new Error("Unknown Google plugin.");
  const clientId = config.googleClientId();
  if (!clientId || !config.googleClientSecret()) {
    throw new Error("Google OAuth is not configured on this server.");
  }
  const scopes = plugin.scopes;
  const verifier = codeVerifier();
  const state = savePending({
    accountId,
    kind: "google",
    pluginId,
    verifier,
    scopes,
    clientId,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", pluginCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  return { installed: false, url: url.toString() };
}

/**
 * Finishes Google consent.
 * Input: database, state id from the redirect, and the authorization code.
 * Output: the account id and plugin name. A state from another account cannot be reused.
 */
export async function finishGoogleOAuth(db: Database, state: string, code: string): Promise<{ accountId: string; name: string }> {
  const pending = takePending(state);
  if (!pending || pending.kind !== "google" || !pending.pluginId) throw new Error("This plugin sign-in expired. Start it again.");
  const clientId = config.googleClientId();
  const clientSecret = config.googleClientSecret();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured on this server.");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: pending.verifier,
    grant_type: "authorization_code",
    redirect_uri: pluginCallbackUrl(),
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as { refresh_token?: string; scope?: string; error_description?: string; error?: string };
  if (!response.ok) throw new Error(json.error_description || json.error || "Google did not return a token.");
  const plugin = await applyGoogleConnection(
    db,
    pending.accountId,
    pending.pluginId,
    json.refresh_token ?? "",
    json.scope || pending.scopes.join(" "),
  );
  return { accountId: pending.accountId, name: plugin.name };
}

/** Mints a short-lived access token on the core. No Google token or client secret is given to the container. */
export async function googleAccessToken(refreshToken: string): Promise<string> {
  const clientId = config.googleClientId();
  const clientSecret = config.googleClientSecret();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured on this server.");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (json.error === "invalid_grant") throw new GoogleGrantRevokedError();
  if (!response.ok || !json.access_token) throw new Error(json.error_description || "Google token refresh failed.");
  return json.access_token;
}

/** Google no longer honors this account's refresh token: the person removed the app's access, or it expired. */
export class GoogleGrantRevokedError extends Error {
  constructor() {
    super("Google access was removed. Connect this plugin again.");
  }
}

const SYNC_TTL_MS = 60_000;
const lastSync = new Map<string, number>();

/**
 * Asks Google which scopes each of this account's Google plugins still holds, and stores the answer.
 * Why: a person can remove access from their Google account at any time, and the stored
 * scopes would keep saying "connected". A revoked sign-in is dropped so the next connect asks again.
 * Each plugin has its own sign-in, so one plugin losing access leaves the others as they are.
 * Input: database, account id, and force to skip the one-minute cache. A network failure keeps what is stored.
 */
export async function syncGoogleGrant(db: Database, accountId: string, options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!options.force && now - (lastSync.get(accountId) ?? 0) < SYNC_TTL_MS) return;
  lastSync.set(accountId, now);
  if (!config.googleClientId() || !config.googleClientSecret()) return;
  const rows = await db
    .select({ slug: mcpServers.slug })
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.kind, "google")));
  await Promise.all(rows.map((row) => syncOnePlugin(db, accountId, row.slug)));
}

async function syncOnePlugin(db: Database, accountId: string, slug: string): Promise<void> {
  const stored = await googleRefreshToken(db, accountId, slug).catch(() => null);
  if (!stored) return;
  let token: string;
  try {
    token = await googleAccessToken(stored.refreshToken);
  } catch (error) {
    if (error instanceof GoogleGrantRevokedError) await forgetGoogleGrant(db, accountId, slug);
    return;
  }
  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!response.ok) return;
    const info = (await response.json()) as { scope?: string };
    if (typeof info.scope === "string" && info.scope !== stored.scopes) {
      await db.update(mcpServers).set({ scopes: info.scope }).where(pluginRow(accountId, slug));
    }
  } catch {
    // Google could not be reached; the stored scopes stand until the next check.
  }
}

/** Drops one plugin's revoked Google sign-in and tells its card why it is no longer connected. */
export async function forgetGoogleGrant(db: Database, accountId: string, slug: string): Promise<void> {
  await db
    .update(mcpServers)
    .set({ secret: seal(""), scopes: "", lastError: new GoogleGrantRevokedError().message })
    .where(pluginRow(accountId, slug));
}

function pluginRow(accountId: string, slug: string) {
  return and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug), eq(mcpServers.kind, "google"));
}
