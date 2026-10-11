import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accountGoogleOauth, mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { catalogPlugin, PLUGIN_CATALOG, scopesCover, type CatalogPlugin, type PluginMark, type PluginSkill } from "./catalog.js";
import { bumpAccountPromptVersions } from "../skills/install.js";
import { writeSharedSkill } from "../skills/local.js";
import { readSecret } from "./credential.js";

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
};

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
  const featured: PluginCard[] = PLUGIN_CATALOG.map((plugin) => {
    const row = rows.find((item) => item.slug === plugin.id && item.kind === "google");
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      section: plugin.section,
      kind: "google",
      mark: plugin.mark,
      skills: plugin.skills,
      installed: Boolean(row),
      configured: Boolean(row) && scopesCover(granted, plugin.scopes),
      lastError: row?.lastError ?? null,
    };
  });
  const custom: PluginCard[] = rows
    .filter((row) => row.kind !== "google")
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
async function installCatalogSkills(db: Database, accountId: string, pluginId: string): Promise<void> {
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
