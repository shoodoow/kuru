/**
 * App keys, sign-in and stored tokens for the Instagram and TikTok plugins.
 * Whose app: each Kuru account brings its own developer app. Instagram and
 * TikTok hand out an app key and secret to whoever registers an app with
 * them, and their limits and reviews belong to that app. The person types
 * the key and secret into the phone once; they are sealed in the plugin's
 * row for that account only. The server's own settings hold none.
 * Why sign in and not paste a token: a pasted access token dies within a day
 * (TikTok) or two months (Instagram). Signing in once gives this server what
 * it needs to renew the token by itself, so an agent can post next month
 * without the person doing anything. Nothing here reaches the account's computer.
 * One plugin can hold several signed-in accounts (two brands, a personal and
 * a business one): signing in again adds one, and each tool says which to
 * act on by its username.
 * Whose it is: keys and sign-ins belong either to one agent or to every
 * agent on the account. The person hands an agent its keys in that agent's
 * chat (see connect.ts), so one agent can run one brand's accounts and
 * another agent a different brand's, each with its own app. An agent uses its
 * own when it has any, and the account's shared ones otherwise.
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

/** The developer app an account signs in with: Instagram's app ID or TikTok's client key, and its secret. */
export type AppKeys = { id: string; secret: string };

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

/** One owner's app keys and signed-in accounts. */
type Scope = { app?: AppKeys; accounts: StoredToken[] };
/** Everything one plugin row keeps sealed: what every agent shares, and what belongs to single agents (by agent id). */
type Stored = Scope & { agents: Record<string, Scope> };

const MARK = "social1.";
const DAY = 24 * 60 * 60 * 1000;

function cleanScope(scope: Partial<Scope> | undefined): Scope {
  return { app: scope?.app?.id && scope.app.secret ? scope.app : undefined, accounts: (scope?.accounts ?? []).filter((token) => token.accessToken) };
}

function readStored(sealed: string | undefined): Stored {
  const plain = sealed ? open(sealed) : "";
  if (!plain.startsWith(MARK)) return { accounts: [], agents: {} };
  const stored = JSON.parse(plain.slice(MARK.length)) as Partial<Stored>;
  const agents: Record<string, Scope> = {};
  for (const [agentId, scope] of Object.entries(stored.agents ?? {})) agents[agentId] = cleanScope(scope);
  return { ...cleanScope(stored), agents };
}

/** One owner's part of a row: an agent's own, or the shared part when no agent is named. */
function scopeOf(stored: Stored, agentId?: string): Scope {
  return agentId ? (stored.agents[agentId] ?? { accounts: [] }) : stored;
}

/** The row with one owner's part replaced. */
function withScope(stored: Stored, agentId: string | undefined, scope: Scope): Stored {
  return agentId ? { ...stored, agents: { ...stored.agents, [agentId]: scope } } : { ...stored, ...scope, app: scope.app };
}

/** Whose sign-ins an agent acts with: its own when it has any, otherwise the ones every agent shares. */
function usableBy(stored: Stored, agentId?: string): { owner: string | undefined; scope: Scope } {
  const own = agentId ? stored.agents[agentId] : undefined;
  return own && own.accounts.length > 0 ? { owner: agentId, scope: own } : { owner: undefined, scope: stored };
}

function anySignedIn(stored: Stored): boolean {
  return stored.accounts.length > 0 || Object.values(stored.agents).some((scope) => scope.accounts.length > 0);
}

async function findRow(db: Database, accountId: string, slug: string) {
  const [row] = await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  return row?.kind === "social" ? row : undefined;
}

/**
 * Writes a plugin row. It is offered to agents only once an account is signed in:
 * a row that holds app keys and nobody signed in is kept switched off.
 */
async function writeRow(db: Database, accountId: string, plugin: CatalogPlugin, stored: Stored, lastError: string | null = null): Promise<void> {
  const values = {
    accountId,
    slug: plugin.id,
    url: plugin.provider === "instagram" ? "https://graph.instagram.com" : "https://open.tiktokapis.com",
    secret: seal(MARK + JSON.stringify(stored)),
    kind: "social",
    enabled: anySignedIn(stored),
    toolsCache: plugin.tools,
    lastError,
  };
  const [existing] = await db.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, plugin.id)));
  if (existing) await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
  else await db.insert(mcpServers).values(values);
}

function socialPlugin(pluginId: string): CatalogPlugin {
  const plugin = catalogPlugin(pluginId);
  if (!plugin || plugin.provider === "google") throw new Error("That plugin does not use its own app keys.");
  return plugin;
}

/**
 * Saves the developer app used for Instagram or TikTok.
 * Input: database, account id, plugin id, the app's key and secret as the
 * platform's developer page shows them, and the agent they belong to (left
 * out, they are shared by every agent). Output: nothing. Accounts already
 * signed in stay; they were signed in with the old app and are asked to
 * connect again if the platform no longer accepts them.
 */
export async function saveSocialApp(db: Database, accountId: string, pluginId: string, input: unknown, agentId?: string): Promise<void> {
  const plugin = socialPlugin(pluginId);
  const data = (input ?? {}) as { key?: unknown; secret?: unknown };
  const id = typeof data.key === "string" ? data.key.trim() : "";
  const secret = typeof data.secret === "string" ? data.secret.trim() : "";
  if (!id || !secret) throw new Error(plugin.provider === "instagram" ? "Enter the Instagram app ID and the Instagram app secret." : "Enter the client key and the client secret.");
  if (id.length > 200 || secret.length > 400 || /\s/.test(id) || /\s/.test(secret)) throw new Error("That does not look like an app key and secret. Copy them again from the developer page.");
  const stored = readStored((await findRow(db, accountId, plugin.id))?.secret);
  await writeRow(db, accountId, plugin, withScope(stored, agentId, { ...scopeOf(stored, agentId), app: { id, secret } }));
}

/**
 * How one plugin stands for one agent, for the connect tool.
 * Output: whether the agent has its own app keys, whether any app keys are
 * there for it to use, and the accounts it would act with.
 */
export async function socialStateFor(db: Database, accountId: string, pluginId: string, agentId?: string): Promise<{ ownApp: boolean; anyApp: boolean; accounts: string[]; own: boolean }> {
  const plugin = socialPlugin(pluginId);
  const stored = readStored((await findRow(db, accountId, plugin.id))?.secret);
  const usable = usableBy(stored, agentId);
  let anyApp = true;
  try {
    appKeysOf(stored, plugin.provider as SocialProvider, agentId);
  } catch {
    anyApp = false;
  }
  return { ownApp: Boolean(scopeOf(stored, agentId).app), anyApp, accounts: usable.scope.accounts.map(label), own: usable.owner !== undefined };
}

/** True when this agent has a signed-in account to act with: its own, or one every agent shares. */
export function socialUsableBy(row: { kind: string; secret: string }, agentId?: string): boolean {
  try {
    return usableBy(readStored(row.kind === "social" ? row.secret : undefined), agentId).scope.accounts.length > 0;
  } catch {
    return false;
  }
}

/**
 * What the phone shows about one plugin: whether shared app keys are saved, and who is signed in.
 * An account that belongs to one agent is shown with that agent's name. Never the keys.
 * Input: the plugin's row and the account's agents by id.
 */
export function socialCardState(row: { kind: string; secret: string } | undefined, agentNames: ReadonlyMap<string, string> = new Map()): { hasApp: boolean; accounts: string[] } {
  try {
    const stored = readStored(row?.kind === "social" ? row.secret : undefined);
    const perAgent = Object.entries(stored.agents).flatMap(([agentId, scope]) => scope.accounts.map((token) => `${label(token)} (${agentNames.get(agentId) ?? "one agent"})`));
    return { hasApp: Boolean(stored.app), accounts: [...stored.accounts.map(label), ...perAgent] };
  } catch {
    return { hasApp: false, accounts: [] };
  }
}

/**
 * The app to sign in with: the agent's own, else the one every agent on the
 * account shares. A server may set one for everybody in its settings; that is the last fallback.
 */
function appKeysOf(stored: Stored, provider: SocialProvider, agentId?: string): AppKeys {
  const own = agentId ? stored.agents[agentId]?.app : undefined;
  if (own) return own;
  if (stored.app) return stored.app;
  const id = provider === "instagram" ? config.instagramAppId() : config.tiktokClientKey();
  const secret = provider === "instagram" ? config.instagramAppSecret() : config.tiktokClientSecret();
  if (id && secret) return { id, secret };
  throw new Error(
    provider === "instagram"
      ? "Add your Instagram app's ID and secret first: ask an agent to connect Instagram, and it will ask for them in the chat."
      : "Add your TikTok app's client key and secret first: ask an agent to connect TikTok, and it will ask for them in the chat.",
  );
}

/**
 * Starts the sign-in for Instagram or TikTok.
 * Input: database, account id, the plugin, and the agent the signed-in account
 * will belong to (left out, every agent shares it). Output: the address the person opens.
 */
export async function startSocialOAuth(db: Database, accountId: string, plugin: CatalogPlugin, agentId?: string): Promise<{ installed: false; url: string }> {
  const provider = plugin.provider as SocialProvider;
  const keys = appKeysOf(readStored((await findRow(db, accountId, plugin.id))?.secret), provider, agentId);
  const state = savePending({ accountId, kind: provider, pluginId: plugin.id, verifier: "", scopes: plugin.scopes, ...(agentId ? { agentId } : {}) });
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
export async function finishSocialOAuth(db: Database, state: string, code: string): Promise<{ accountId: string; name: string; pluginId: string }> {
  const pending = takePending(state);
  if (!pending || (pending.kind !== "instagram" && pending.kind !== "tiktok") || !pending.pluginId) {
    throw new Error("This plugin sign-in expired. Start it again.");
  }
  const plugin = catalogPlugin(pending.pluginId);
  if (!plugin) throw new Error("Unknown plugin.");
  const keys = appKeysOf(readStored((await findRow(db, pending.accountId, plugin.id))?.secret), pending.kind, pending.agentId);
  const token = pending.kind === "instagram" ? await instagramToken(code, keys) : await tiktokToken(code, keys);
  await saveSocialAccount(db, pending.accountId, plugin, token, pending.agentId);
  return { accountId: pending.accountId, name: plugin.name, pluginId: plugin.id };
}

async function instagramToken(code: string, keys: AppKeys): Promise<StoredToken> {
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

async function tiktokGrant(keys: AppKeys, body: Record<string, string>): Promise<Json> {
  const reply = await callJson("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: keys.id, client_secret: keys.secret, ...body }),
  });
  // TikTok reports a refused grant with HTTP 200 and an error field.
  if (!reply.access_token) throw new Error(`TikTok did not return a token: ${reply.error_description ?? reply.error ?? "no reason given"}.`);
  return reply;
}

async function tiktokToken(code: string, keys: AppKeys): Promise<StoredToken> {
  const reply = await tiktokGrant(keys, { code, grant_type: "authorization_code", redirect_uri: pluginCallbackUrl() });
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

/** The name a person would call a signed-in account by. */
function label(token: StoredToken): string {
  return token.username ? `@${token.username}` : token.userId;
}

/**
 * Saves one signed-in account: replaces the same account's older token, or adds it beside the others. The app keys stay.
 * Input: database, account id, plugin, the token, and the agent it belongs to (left out, every agent shares it).
 */
export async function saveSocialAccount(db: Database, accountId: string, plugin: CatalogPlugin, token: StoredToken, agentId?: string): Promise<void> {
  const stored = readStored((await findRow(db, accountId, plugin.id))?.secret);
  const scope = scopeOf(stored, agentId);
  await writeRow(db, accountId, plugin, withScope(stored, agentId, { ...scope, accounts: [...scope.accounts.filter((row) => row.userId !== token.userId), token] }));
}

/**
 * The access token to use right now, renewed first when it is close to running out.
 * Instagram: a 60-day token, renewed once fewer than 30 days remain.
 * TikTok: a 24-hour token, renewed with the year-long refresh token.
 * Input: database, account id, plugin slug, which signed-in account (its
 * username) when several are connected, and the agent asking. An agent acts
 * with its own accounts when it has any, otherwise with the shared ones.
 * Output: the token and whose account it is.
 */
export async function socialAccessToken(db: Database, accountId: string, slug: string, which?: string, agentId?: string): Promise<{ token: string; userId: string; username?: string; connected: string[] }> {
  const plugin = catalogPlugin(slug);
  const row = await findRow(db, accountId, slug);
  const kept = readStored(row?.secret);
  const { owner, scope } = usableBy(kept, agentId);
  const tokens = scope.accounts;
  if (!plugin || !row || tokens.length === 0) {
    throw new Error(`No ${plugin?.name ?? slug} account is connected for you. Call connect_social to connect one.`);
  }
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
      await saveSocialAccount(db, accountId, plugin, stored, owner);
    }
    if (plugin.provider === "tiktok" && stored.expiresAt - now < 5 * 60_000) {
      if (!stored.refreshToken) throw new Error("no refresh token");
      const renewed = await tiktokGrant(appKeysOf(kept, "tiktok", owner), { grant_type: "refresh_token", refresh_token: stored.refreshToken });
      // TikTok may hand back a new refresh token; the old one stops working when it does.
      stored = { ...stored, accessToken: String(renewed.access_token), refreshToken: String(renewed.refresh_token ?? stored.refreshToken), expiresAt: now + Number(renewed.expires_in ?? 86_400) * 1000, issuedAt: now };
      await saveSocialAccount(db, accountId, plugin, stored, owner);
    }
  } catch (error) {
    if (stored.expiresAt > now) return { token: stored.accessToken, userId: stored.userId, username: stored.username, connected };
    const reason = `The ${plugin.name} sign-in for ${label(stored)} ran out and could not be renewed (${error instanceof Error ? error.message : "unknown reason"}). Call connect_social and send the person the sign-in link again.`;
    await db.update(mcpServers).set({ lastError: reason }).where(eq(mcpServers.id, row.id));
    throw new Error(reason);
  }
  if (stored.expiresAt <= now) throw new Error(`The ${plugin.name} sign-in for ${label(stored)} ran out. Call connect_social and send the person the sign-in link again.`);
  return { token: stored.accessToken, userId: stored.userId, username: stored.username, connected };
}
