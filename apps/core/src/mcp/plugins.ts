import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accountGoogleOauth, agents, mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { catalogPlugin, PLUGIN_CATALOG, scopesCover, type CatalogPlugin, type PluginMark, type PluginSkill } from "./catalog.js";
import { bumpAccountPromptVersions } from "../skills/install.js";
import { writeSharedSkill } from "../skills/local.js";
import { readSecret } from "./credential.js";
import { socialCardState } from "../social/accounts.js";
import { config } from "../config.js";
import { pluginCallbackUrl } from "./oauth-pending.js";

type Database = ReturnType<typeof getDb>;

export type PluginCard = {
  id: string;
  name: string;
  description: string;
  section: string;
  kind: "google" | "remote";
  mark: PluginMark;
  skills: PluginSkill[];
  installed: boolean;
  configured: boolean;
  lastError: string | null;
  /** The accounts signed in to this plugin, by username. Only Instagram and TikTok hold more than one. */
  accounts?: string[];
  /** True when signing in again adds another account beside the ones already there. */
  multiAccount?: boolean;
  /**
   * Set for a plugin each person connects with their own developer app
   * (Instagram, TikTok): whether its key and secret are saved, what the two
   * fields are called, where to make the app, and the steps. Never the keys.
   */
  app?: { saved: boolean; keyLabel: string; secretLabel: string; portal: string; redirect: string; steps: string[] };
};

/** True when the server's own settings carry an app for everybody, so a person need not add theirs. */
function serverHasApp(provider: CatalogPlugin["provider"]): boolean {
  return provider === "instagram" ? Boolean(config.instagramAppId() && config.instagramAppSecret()) : Boolean(config.tiktokClientKey() && config.tiktokClientSecret());
}

const customColors = ["#7C5CFF", "#FF2D55", "#0A84FF", "#2DD4BF", "#30D158", "#A78BFA", "#FF9F0A"];

/** Builds a mark for a connector that is not in the catalog. */
function markForName(name: string): PluginMark {
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % customColors.length;
  return { icon: null, letter: name.trim().slice(0, 1).toUpperCase() || "?", color: customColors[hash] ?? customColors[0]! };
}

/**
 * Lists the catalog plus this account's own connectors.
 * Input: database and account id. Output: cards with no secrets and no other account's rows.
 */
export async function listAccountPlugins(db: Database, accountId: string): Promise<{ installed: number; plugins: PluginCard[] }> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
  const [google] = await db.select().from(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  const granted = google?.scopes ?? "";
  const named = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.accountId, accountId));
  const agentNames = new Map(named.map((agent) => [agent.id, agent.name]));
  const featured: PluginCard[] = PLUGIN_CATALOG.map((plugin) => {
    const row = rows.find((item) => item.slug === plugin.id && (item.kind === "google" || item.kind === "social"));
    const social = plugin.provider === "google" ? null : socialCardState(row, agentNames);
    // A row that only holds app keys, with nobody signed in yet, is not an installed plugin.
    const installed = social ? social.accounts.length > 0 : Boolean(row);
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      section: plugin.section,
      kind: "google",
      mark: plugin.mark,
      skills: plugin.skills,
      installed,
      // A Google plugin works when the shared Google sign-in covers it; the others carry their own.
      configured: installed && (plugin.provider === "google" ? scopesCover(granted, plugin.scopes) : !row?.lastError),
      lastError: installed ? (row?.lastError ?? null) : null,
      ...(social && plugin.app
        ? { multiAccount: true, accounts: social.accounts, app: { saved: social.hasApp || serverHasApp(plugin.provider), redirect: pluginCallbackUrl(), ...plugin.app } }
        : {}),
    };
  });
  const custom: PluginCard[] = rows
    .filter((row) => row.kind === "remote")
    .map((row) => ({
      id: row.slug,
      name: row.slug,
      description: row.url,
      section: "Your plugins",
      kind: "remote" as const,
      mark: markForName(row.slug),
      skills: [],
      installed: true,
      configured: !row.lastError,
      lastError: row.lastError,
    }));
  const plugins = [...featured, ...custom];
  return { installed: plugins.filter((plugin) => plugin.installed).length, plugins };
}

/**
 * Saves a Google refresh token for one account and marks one featured plugin installed.
 * The login session is not read or written. The refresh token stays sealed in the database.
 */
export async function applyGoogleConnection(
  db: Database,
  accountId: string,
  pluginId: string,
  refreshToken: string,
  grantedScopes: string,
): Promise<CatalogPlugin> {
  const plugin = catalogPlugin(pluginId);
  if (!plugin) throw new Error("Unknown Google plugin.");
  if (!refreshToken.trim()) throw new Error("Google did not return a refresh token.");
  const sealed = seal(refreshToken);
  const [existing] = await db.select().from(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  if (existing) {
    await db
      .update(accountGoogleOauth)
      .set({ secret: sealed, scopes: grantedScopes })
      .where(eq(accountGoogleOauth.accountId, accountId));
  } else {
    await db.insert(accountGoogleOauth).values({ accountId, secret: sealed, scopes: grantedScopes });
  }
  await upsertGooglePlugin(db, accountId, plugin, scopesCover(grantedScopes, plugin.scopes) ? null : "Google did not grant every permission this plugin needs.");
  await installCatalogSkills(db, accountId, plugin.id);
  return plugin;
}

/** Installs a featured plugin when this account's Google token already includes its scopes. */
export async function installGooglePluginIfGranted(db: Database, accountId: string, pluginId: string): Promise<boolean> {
  const plugin = catalogPlugin(pluginId);
  if (!plugin) throw new Error("Unknown Google plugin.");
  const [google] = await db.select().from(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  if (!google || !scopesCover(google.scopes, plugin.scopes)) return false;
  await upsertGooglePlugin(db, accountId, plugin, null);
  await installCatalogSkills(db, accountId, plugin.id);
  return true;
}

/** Saves this plugin's skills on the account's computer. A computer that cannot be reached does not undo the connection. */
export async function installCatalogSkills(db: Database, accountId: string, pluginId: string): Promise<void> {
  const plugin = catalogPlugin(pluginId);
  if (!plugin?.skills.length) return;
  try {
    for (const skill of plugin.skills) {
      const markdown = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
      await writeSharedSkill(accountId, markdown);
    }
    void bumpAccountPromptVersions(db, accountId);
  } catch {
    // The connector stays connected when a bundled skill cannot be written.
  }
}

export async function grantedGoogleScopes(db: Database, accountId: string): Promise<string> {
  const [google] = await db.select({ scopes: accountGoogleOauth.scopes }).from(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  return google?.scopes ?? "";
}

export async function googleRefreshToken(db: Database, accountId: string): Promise<{ refreshToken: string; scopes: string } | null> {
  const [google] = await db.select().from(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  if (!google) return null;
  return { refreshToken: readSecret(google.secret).bearer, scopes: google.scopes };
}

async function upsertGooglePlugin(db: Database, accountId: string, plugin: CatalogPlugin, lastError: string | null): Promise<void> {
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, plugin.id)));
  const values = {
    accountId,
    slug: plugin.id,
    url: "https://www.googleapis.com",
    secret: seal(""),
    kind: "google",
    enabled: true,
    toolsCache: plugin.tools,
    lastError,
  };
  if (existing) {
    await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
    return;
  }
  await db.insert(mcpServers).values(values);
}

/** Drops the account Google token once no featured Google plugin remains. */
export async function dropGoogleTokenIfUnused(db: Database, accountId: string): Promise<boolean> {
  const rows = await db.select({ slug: mcpServers.slug }).from(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.kind, "google")));
  if (rows.length > 0) return false;
  await db.delete(accountGoogleOauth).where(eq(accountGoogleOauth.accountId, accountId));
  return true;
}
