/**
 * Sign-in and stored tokens for the Instagram and TikTok plugins.
 * Why here and not a pasted token: a pasted access token dies within a day
 * (TikTok) or two months (Instagram). Signing in once gives this server what
 * it needs to renew the token by itself, so an agent can post next month
 * without the person doing anything. The token is sealed in the plugin's row
 * and never reaches the account's computer.
 * One plugin can hold several signed-in accounts (two brands, a personal and
 * a business one): signing in again adds one, and each tool says which to
 * act on by its username.
 * YouTube is not here: it is a Google plugin and uses the Google sign-in.
 */
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import type { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { open, seal } from "../keys/keys.js";
import { catalogPlugin, type CatalogPlugin } from "../mcp/catalog.js";
import { pluginCallbackUrl, savePending, takePending } from "../mcp/oauth-pending.js";
import { callJson, type Json } from "./http.js";
import { INSTAGRAM_GRAPH } from "./instagram.js";

type Database = ReturnType<typeof getDb>;
export type SocialProvider = "instagram" | "tiktok";

export type StoredToken = {
  accessToken: string;
  /** TikTok only: used to get a new access token. */
  refreshToken?: string;
  /** When the access token stops working, in milliseconds. */
  expiresAt: number;
  /** When it was issued; Instagram renews a token only once it is a day old. */
  issuedAt: number;
  userId: string;
  username?: string;
};

const MARK = "social1.";
const DAY = 24 * 60 * 60 * 1000;

function appKeys(provider: SocialProvider): { id: string; secret: string } {
  const id = provider === "instagram" ? config.instagramAppId() : config.tiktokClientKey();
  const secret = provider === "instagram" ? config.instagramAppSecret() : config.tiktokClientSecret();
  if (!id || !secret) {
    throw new Error(
      provider === "instagram"
        ? "Instagram is not set up on this server. Whoever runs it adds INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to apps/core/.env (see deploy/SETUP.md, Social plugins)."
        : "TikTok is not set up on this server. Whoever runs it adds TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to apps/core/.env (see deploy/SETUP.md, Social plugins).",
    );
  }
  return { id, secret };
}

/**
 * Starts the sign-in for Instagram or TikTok.
 * Input: account id and the plugin. Output: the address the phone opens.
 */
export function startSocialOAuth(accountId: string, plugin: CatalogPlugin): { installed: false; url: string } {
  const provider = plugin.provider as SocialProvider;
  const keys = appKeys(provider);
  const state = savePending({ accountId, kind: provider, pluginId: plugin.id, verifier: "", scopes: plugin.scopes });
  const url = new URL(provider === "instagram" ? "https://www.instagram.com/oauth/authorize" : "https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set(provider === "instagram" ? "client_id" : "client_key", keys.id);
  url.searchParams.set("redirect_uri", pluginCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", plugin.scopes.join(","));
  url.searchParams.set("state", state);
  // Always ask who is signing in: the person may be adding a second account, and
  // without this the platform silently reuses the one their browser is logged in to.
  if (provider === "instagram") url.searchParams.set("force_reauth", "true");
  else url.searchParams.set("disable_auto_auth", "1");
  return { installed: false, url: url.toString() };
}

/**
 * Finishes the sign-in: trades the code for a token and saves the plugin.
 * Input: database, the state id from the redirect, and the code. Output: the account id and plugin name.
 */
export async function finishSocialOAuth(db: Database, state: string, code: string): Promise<{ accountId: string; name: string }> {
  const pending = takePending(state);
  if (!pending || (pending.kind !== "instagram" && pending.kind !== "tiktok") || !pending.pluginId) {
    throw new Error("This plugin sign-in expired. Start it again.");
  }
  const plugin = catalogPlugin(pending.pluginId);
  if (!plugin) throw new Error("Unknown plugin.");
  const token = pending.kind === "instagram" ? await instagramToken(code) : await tiktokToken(code);
  await saveSocialAccount(db, pending.accountId, plugin, token);
  return { accountId: pending.accountId, name: plugin.name };
}

async function instagramToken(code: string): Promise<StoredToken> {
  const keys = appKeys("instagram");
  const short = await callJson("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Instagram appends "#_" to the code; it is not part of it.
    body: new URLSearchParams({ client_id: keys.id, client_secret: keys.secret, grant_type: "authorization_code", redirect_uri: pluginCallbackUrl(), code: code.replace(/#_$/, "") }),
  });
  const first = (Array.isArray(short.data) ? short.data[0] : short) as Json;
  if (!first?.access_token) throw new Error("Instagram did not return a token.");
  // The first token lasts an hour. This trade gives the 60-day one that can be renewed.
  const long = await callJson(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: keys.secret, access_token: String(first.access_token) })}`);
  const me = await callJson(`${INSTAGRAM_GRAPH}/me?${new URLSearchParams({ fields: "user_id,username", access_token: String(long.access_token) })}`).catch((): Json => ({}));
  return {
    accessToken: String(long.access_token),
    expiresAt: Date.now() + Number(long.expires_in ?? 60 * 24 * 3600) * 1000,
    issuedAt: Date.now(),
    userId: String(me.user_id ?? first.user_id ?? ""),
    username: typeof me.username === "string" ? me.username : undefined,
  };
}

async function tiktokGrant(body: Record<string, string>): Promise<Json> {
  const keys = appKeys("tiktok");
  const reply = await callJson("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: keys.id, client_secret: keys.secret, ...body }),
  });
  // TikTok reports a refused grant with HTTP 200 and an error field.
  if (!reply.access_token) throw new Error(`TikTok did not return a token: ${reply.error_description ?? reply.error ?? "no reason given"}.`);
  return reply;
}

async function tiktokToken(code: string): Promise<StoredToken> {
  const reply = await tiktokGrant({ code, grant_type: "authorization_code", redirect_uri: pluginCallbackUrl() });
  // The username is how the person and the agent tell two accounts apart.
  const info = await callJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name", { headers: { authorization: `Bearer ${String(reply.access_token)}` } }).catch((): Json => ({}));
  const user = (info.data?.user ?? {}) as Json;
  return {
    accessToken: String(reply.access_token),
    refreshToken: String(reply.refresh_token ?? ""),
    expiresAt: Date.now() + Number(reply.expires_in ?? 86_400) * 1000,
    issuedAt: Date.now(),
    userId: String(reply.open_id ?? ""),
    username: typeof user.username === "string" && user.username ? user.username : typeof user.display_name === "string" ? user.display_name : undefined,
  };
}

/** The signed-in accounts kept in one plugin row. Output: an empty list for a row that holds none. */
function readTokens(sealed: string | undefined): StoredToken[] {
  const plain = sealed ? open(sealed) : "";
  if (!plain.startsWith(MARK)) return [];
  return ((JSON.parse(plain.slice(MARK.length)) as { accounts?: StoredToken[] }).accounts ?? []).filter((token) => token.accessToken);
}

/** The name a person would call a signed-in account by. */
function label(token: StoredToken): string {
  return token.username ? `@${token.username}` : token.userId;
}

/** The usernames signed in to one plugin, for the plugin's card on the phone. */
export function socialIdentities(sealed: string | undefined): string[] {
  try {
    return readTokens(sealed).map(label);
  } catch {
    return [];
  }
}

/** Saves one signed-in account: replaces the same account's older token, or adds it beside the others. */
export async function saveSocialAccount(db: Database, accountId: string, plugin: CatalogPlugin, token: StoredToken, lastError: string | null = null): Promise<void> {
  const [existing] = await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, plugin.id)));
  const others = readTokens(existing?.kind === "social" ? existing.secret : undefined).filter((row) => row.userId !== token.userId);
  const values = {
    accountId,
    slug: plugin.id,
    url: plugin.provider === "instagram" ? "https://graph.instagram.com" : "https://open.tiktokapis.com",
    secret: seal(MARK + JSON.stringify({ accounts: [...others, token] })),
    kind: "social",
    enabled: true,
    toolsCache: plugin.tools,
    lastError,
  };
  if (existing) await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
  else await db.insert(mcpServers).values(values);
}

/**
 * The access token to use right now, renewed first when it is close to running out.
 * Instagram: a 60-day token, renewed once fewer than 30 days remain.
 * TikTok: a 24-hour token, renewed with the year-long refresh token.
 * Input: database, account id, plugin slug, and which signed-in account (its
 * username) when several are connected. Output: the token and whose account it is.
 */
export async function socialAccessToken(db: Database, accountId: string, slug: string, which?: string): Promise<{ token: string; userId: string; username?: string; connected: string[] }> {
  const plugin = catalogPlugin(slug);
  const [row] = await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  const tokens = readTokens(row?.secret);
  if (!plugin || !row || tokens.length === 0) throw new Error(`Connect the ${plugin?.name ?? slug} plugin again: its sign-in is missing.`);
  const connected = tokens.map(label);
  const wanted = which?.trim().replace(/^@/, "").toLowerCase();
  let stored = wanted ? tokens.find((token) => token.username?.toLowerCase() === wanted || token.userId === wanted) : tokens.length === 1 ? tokens[0] : undefined;
  if (!stored) {
    throw new Error(
      wanted
        ? `No ${plugin.name} account named ${which} is connected. Connected: ${connected.join(", ")}.`
        : `Several ${plugin.name} accounts are connected: ${connected.join(", ")}. Say which one with the account argument. If the person did not say, ask them.`,
    );
  }
  const now = Date.now();
  try {
    if (plugin.provider === "instagram" && stored.expiresAt - now < 30 * DAY && now - stored.issuedAt > DAY) {
      const renewed = await callJson(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: stored.accessToken })}`);
      stored = { ...stored, accessToken: String(renewed.access_token), expiresAt: now + Number(renewed.expires_in ?? 60 * 24 * 3600) * 1000, issuedAt: now };
      await saveSocialAccount(db, accountId, plugin, stored);
    }
    if (plugin.provider === "tiktok" && stored.expiresAt - now < 5 * 60_000) {
      if (!stored.refreshToken) throw new Error("no refresh token");
      const renewed = await tiktokGrant({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
      // TikTok may hand back a new refresh token; the old one stops working when it does.
      stored = { ...stored, accessToken: String(renewed.access_token), refreshToken: String(renewed.refresh_token ?? stored.refreshToken), expiresAt: now + Number(renewed.expires_in ?? 86_400) * 1000, issuedAt: now };
      await saveSocialAccount(db, accountId, plugin, stored);
    }
  } catch (error) {
    if (stored.expiresAt > now) return { token: stored.accessToken, userId: stored.userId, username: stored.username, connected };
    const reason = `The ${plugin.name} sign-in for ${label(stored)} ran out and could not be renewed (${error instanceof Error ? error.message : "unknown reason"}). Ask the person to connect ${plugin.name} again in Plugins.`;
    await db.update(mcpServers).set({ lastError: reason }).where(eq(mcpServers.id, row.id));
    throw new Error(reason);
  }
  if (stored.expiresAt <= now) throw new Error(`The ${plugin.name} sign-in for ${label(stored)} ran out. Ask the person to connect ${plugin.name} again in Plugins.`);
  return { token: stored.accessToken, userId: stored.userId, username: stored.username, connected };
}
