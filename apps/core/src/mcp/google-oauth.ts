import { config } from "../config.js";
import type { getDb } from "../db/client.js";
import { catalogPlugin } from "./catalog.js";
import { codeChallenge, codeVerifier, pluginCallbackUrl, savePending, takePending } from "./oauth-pending.js";
import { applyGoogleConnection, grantedGoogleScopes, installGooglePluginIfGranted } from "./plugins.js";
import { startSocialOAuth } from "../social/accounts.js";

type Database = ReturnType<typeof getDb>;

/**
 * Starts Google consent for one featured plugin.
 * Why: Gmail, Calendar, and Drive are not MCP servers. The phone opens Google, and the refresh token is stored for this account only.
 * Input: database, account id, plugin id. Output: an authorize URL, or installed when the current token already covers the plugin.
 */
export async function startGoogleOAuth(
  db: Database,
  accountId: string,
  pluginId: string,
): Promise<{ installed: true } | { installed: false; url: string }> {
  const plugin = catalogPlugin(pluginId);
  if (!plugin) throw new Error("Unknown plugin.");
  // Instagram and TikTok have their own sign-in; the phone starts every featured plugin here.
  if (plugin.provider !== "google") return startSocialOAuth(db, accountId, plugin);
  const clientId = config.googleClientId();
  if (!clientId || !config.googleClientSecret()) {
    throw new Error("Google OAuth is not configured on this server.");
  }
  if (await installGooglePluginIfGranted(db, accountId, pluginId)) return { installed: true };
  const already = (await grantedGoogleScopes(db, accountId)).split(/\s+/).filter(Boolean);
  const scopes = [...new Set([...already, ...plugin.scopes])];
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
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
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
  const json = (await response.json()) as { access_token?: string; error_description?: string };
  if (!response.ok || !json.access_token) throw new Error(json.error_description || "Google token refresh failed.");
  return json.access_token;
}
