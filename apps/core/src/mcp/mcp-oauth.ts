import type { getDb } from "../db/client.js";
import { eq } from "drizzle-orm";
import { mcpServers } from "../db/schema.js";
import { catalogPlugin } from "./catalog.js";
import { sealOAuth, type OAuthSecret } from "./credential.js";
import { codeChallenge, codeVerifier, pluginCallbackUrl, savePending, takePending } from "./oauth-pending.js";
import { publicFetch } from "../net/public-fetch.js";
import { assertSafeMcpUrl } from "./url.js";

type Database = ReturnType<typeof getDb>;
type FetchImpl = typeof fetch;

type AuthServer = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string;
};

/**
 * The address a token is asked for, so it is only good at this server.
 * This is the `resource` of RFC 8707, which the MCP sign-in rules require on
 * every authorize and token request: the server URL without a fragment.
 */
export function resourceOf(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.hash = "";
  return url.toString();
}

/**
 * Reads OAuth metadata for a public MCP server.
 * The server names its authorization server in its protected-resource
 * metadata. A server that publishes none is taken to be its own authorization
 * server, which is how older servers work.
 * Input: the MCP URL. Output: authorize and token endpoints, or null when no sign-in can be found.
 */
export async function discoverMcpOAuth(mcpUrl: string, fetchImpl: FetchImpl = publicFetch): Promise<AuthServer | null> {
  assertSafeMcpUrl(mcpUrl);
  const resource = await resourceMetadataUrl(mcpUrl, fetchImpl);
  let metadata: Record<string, unknown> = {};
  if (resource) {
    assertSafeMcpUrl(resource);
    metadata = await readJson(fetchImpl, resource);
  }
  const issuer = firstString(metadata.authorization_servers) || new URL(mcpUrl).origin;
  assertSafeMcpUrl(issuer);
  let auth: Record<string, unknown> = {};
  for (const candidate of authorizationMetadataUrls(issuer)) {
    auth = await readJson(fetchImpl, candidate);
    if (stringField(auth.authorization_endpoint) && stringField(auth.token_endpoint)) break;
  }
  const authorizationEndpoint = stringField(auth.authorization_endpoint);
  const tokenEndpoint = stringField(auth.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  assertSafeMcpUrl(authorizationEndpoint);
  assertSafeMcpUrl(tokenEndpoint);
  const registrationEndpoint = stringField(auth.registration_endpoint);
  if (registrationEndpoint) assertSafeMcpUrl(registrationEndpoint);
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    scopes: stringField(metadata.scopes_supported) || arrayField(metadata.scopes_supported),
  };
}

/**
 * Starts MCP OAuth for one account's custom server.
 * Input: database, account id, slug, and public URL. Output: the authorize URL. The refresh token is stored later on that account's row.
 */
export async function startMcpOAuth(
  db: Database,
  accountId: string,
  slug: string,
  url: string,
  fetchImpl: FetchImpl = publicFetch,
): Promise<{ url: string }> {
  void db;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) throw new Error("Slug must start with a letter and use lowercase letters, digits, _ or -.");
  if (catalogPlugin(slug)) throw new Error("That name is reserved for a featured plugin.");
  const discovered = await discoverMcpOAuth(url, fetchImpl);
  if (!discovered) throw new Error("This server does not publish OAuth. Paste a bearer token instead.");
  const clientId = discovered.registrationEndpoint
    ? await registerClient(discovered.registrationEndpoint, fetchImpl)
    : "";
  if (!clientId) {
    throw new Error("This server has a sign-in but does not let apps register themselves. Paste a bearer token instead.");
  }
  const verifier = codeVerifier();
  const scopes = discovered.scopes ? discovered.scopes.split(/\s+/) : [];
  const state = savePending({
    accountId,
    kind: "mcp",
    slug,
    url,
    verifier,
    scopes,
    tokenEndpoint: discovered.tokenEndpoint,
    clientId,
  });
  const resource = resourceOf(url);
  const authorize = new URL(discovered.authorizationEndpoint);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", pluginCallbackUrl());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("code_challenge", codeChallenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("resource", resource);
  if (scopes.length) authorize.searchParams.set("scope", scopes.join(" "));
  return { url: authorize.toString() };
}

/**
 * Finishes MCP OAuth and stores the token on the pending account's connector row.
 * Input: database, state, and authorization code. Output: the account id and slug.
 */
export async function finishMcpOAuth(
  db: Database,
  state: string,
  code: string,
  fetchImpl?: FetchImpl,
): Promise<{ accountId: string; slug: string }> {
  const pending = takePending(state);
  if (!pending || pending.kind !== "mcp" || !pending.slug || !pending.url || !pending.tokenEndpoint || !pending.clientId) {
    throw new Error("This plugin sign-in expired. Start it again.");
  }
  const token = await exchangeCode(pending.tokenEndpoint, {
    client_id: pending.clientId,
    code,
    code_verifier: pending.verifier,
    grant_type: "authorization_code",
    redirect_uri: pluginCallbackUrl(),
    resource: resourceOf(pending.url),
  }, fetchImpl);
  const oauth: OAuthSecret = {
    refreshToken: token.refresh_token || "",
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    resource: resourceOf(pending.url),
  };
  const { saveOAuthMcpServer } = await import("./store.js");
  await saveOAuthMcpServer(db, pending.accountId, { slug: pending.slug, url: pending.url, oauth }, fetchImpl);
  return { accountId: pending.accountId, slug: pending.slug };
}

export async function refreshOAuthSecret(oauth: OAuthSecret, fetchImpl: FetchImpl = publicFetch): Promise<OAuthSecret> {
  assertSafeMcpUrl(oauth.tokenEndpoint);
  const token = await exchangeCode(
    oauth.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: oauth.clientId,
      // Sign-ins saved before this was recorded refresh without it.
      ...(oauth.resource ? { resource: oauth.resource } : {}),
    },
    fetchImpl,
  );
  return {
    ...oauth,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
}

export async function updateOAuthSecret(db: Database, rowId: string, oauth: OAuthSecret): Promise<void> {
  await db.update(mcpServers).set({ secret: sealOAuth(oauth) }).where(eq(mcpServers.id, rowId));
}

async function registerClient(registrationEndpoint: string, fetchImpl: FetchImpl = publicFetch): Promise<string> {
  const response = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Kuru",
      redirect_uris: [pluginCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const json = (await response.json()) as { client_id?: string };
  if (!response.ok || !json.client_id) return "";
  return json.client_id;
}

async function exchangeCode(
  tokenEndpoint: string,
  fields: Record<string, string>,
  fetchImpl: FetchImpl = publicFetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) throw new Error(json.error || "The MCP server did not return a token.");
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in };
}

async function resourceMetadataUrl(mcpUrl: string, fetchImpl: FetchImpl): Promise<string | null> {
  const response = await fetchImpl(mcpUrl, { method: "GET", redirect: "manual", headers: { accept: "application/json" } });
  const header = response.headers.get("www-authenticate") ?? "";
  const quoted = header.match(/resource_metadata="([^"]+)"/i)?.[1];
  if (quoted) return quoted;
  // Not announced: look where the rules say it lives, for this path first and then for the whole host.
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/\/$/, "");
  const places = [...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []), `${url.origin}/.well-known/oauth-protected-resource`];
  for (const place of places) {
    const probe = await fetchImpl(place, { method: "GET", redirect: "manual" });
    if (probe.ok) return place;
  }
  return null;
}

/**
 * Where an authorization server may publish its metadata, most standard first.
 * An issuer with a path puts the well-known part before the path (RFC 8414);
 * OpenID servers use their own document; older servers append it after the path.
 */
export function authorizationMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const places = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`, `${url.origin}${path}/.well-known/oauth-authorization-server`] : []),
  ];
  return [...new Set(places)];
}

async function readJson(fetchImpl: FetchImpl, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { redirect: "manual" });
  if (!response.ok) return {};
  return (await response.json()) as Record<string, unknown>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function arrayField(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(" ");
}
