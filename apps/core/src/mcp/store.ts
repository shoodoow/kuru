/**
 * Per-account MCP server records (URL + sealed bearer). Stdio stays out of tenant config.
 */
import { mcpServerInputSchema } from "@kuru/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { catalogPlugin } from "./catalog.js";
import { callMcpTool, listMcpTools, McpAuthError, toolResultText } from "./client.js";
import { readSecret, sealOAuth, type OAuthSecret } from "./credential.js";
import { refreshOAuthSecret, updateOAuthSecret } from "./mcp-oauth.js";
import { dropGoogleTokenIfUnused } from "./plugins.js";
import type { McpToolCacheEntry } from "./types.js";
import { assertSafeMcpUrl } from "./url.js";

type Database = ReturnType<typeof getDb>;

export type StoredMcpServer = {
  id: string;
  slug: string;
  url: string;
  kind: string;
  enabled: boolean;
  configured: boolean;
  tools: McpToolCacheEntry[];
  lastError: string | null;
};

/** Shown on the plugin when the server connects but has nothing to offer. */
const NO_TOOLS = "The server answered but lists no tools.";

function parseToolsCache(raw: unknown): McpToolCacheEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is McpToolCacheEntry => typeof row === "object" && row !== null && typeof (row as McpToolCacheEntry).name === "string");
}

function toStored(row: typeof mcpServers.$inferSelect): StoredMcpServer {
  const tools = parseToolsCache(row.toolsCache);
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    kind: row.kind,
    enabled: row.enabled,
    configured: tools.length > 0 && !row.lastError,
    tools,
    lastError: row.lastError,
  };
}

export async function listMcpServers(db: Database, accountId: string): Promise<StoredMcpServer[]> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
  return rows.map(toStored).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function deleteMcpServer(db: Database, accountId: string, slug: string): Promise<void> {
  const [row] = await db
    .select({ id: mcpServers.id, kind: mcpServers.kind })
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (!row) return;
  await db.delete(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (row.kind === "google") await dropGoogleTokenIfUnused(db, accountId);
}

export async function saveMcpServer(db: Database, accountId: string, input: unknown): Promise<StoredMcpServer> {
  const data = mcpServerInputSchema.parse(input);
  if (catalogPlugin(data.slug)) throw new Error("That name is reserved for a featured plugin.");
  assertSafeMcpUrl(data.url);
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, data.slug)));
  const typed = data.secret.trim()
    ? { secret: seal(data.secret.trim()), bearer: data.secret.trim() }
    : existing?.secret
      ? { secret: existing.secret, bearer: await bearerForRow(db, existing) }
      : { secret: seal(""), bearer: "" };

  let toolsCache: McpToolCacheEntry[] = existing ? parseToolsCache(existing.toolsCache) : [];
  let lastError: string | null = null;
  try {
    toolsCache = await listMcpTools(data.url, typed.bearer);
    if (toolsCache.length === 0) lastError = NO_TOOLS;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP server.";
    toolsCache = [];
  }

  const enabled = data.enabled ?? existing?.enabled ?? true;
  const values = {
    accountId,
    slug: data.slug,
    url: data.url,
    secret: typed.secret,
    kind: "remote",
    enabled,
    toolsCache,
    lastError,
  };

  if (existing) {
    await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, existing.id));
    return toStored(row!);
  }
  const [row] = await db.insert(mcpServers).values(values).returning();
  return toStored(row!);
}

export async function mcpRowsForAccount(db: Database, accountId: string): Promise<(typeof mcpServers.$inferSelect)[]> {
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.enabled, true)));
}

/**
 * Stores an OAuth refresh bundle for one custom MCP and reads the server's tool list.
 */
export async function saveOAuthMcpServer(
  db: Database,
  accountId: string,
  input: { slug: string; url: string; oauth: OAuthSecret },
  fetchImpl?: typeof fetch,
): Promise<StoredMcpServer> {
  const sealed = sealOAuth(input.oauth);
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, input.slug)));
  let toolsCache: McpToolCacheEntry[] = [];
  let lastError: string | null = null;
  try {
    toolsCache = await listMcpTools(input.url, input.oauth.accessToken, fetchImpl);
    if (toolsCache.length === 0) lastError = NO_TOOLS;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP server.";
  }
  const values = {
    accountId,
    slug: input.slug,
    url: input.url,
    secret: sealed,
    kind: "remote",
    enabled: true,
    toolsCache,
    lastError,
  };
  if (existing) {
    await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, existing.id));
    return toStored(row!);
  }
  const [row] = await db.insert(mcpServers).values(values).returning();
  return toStored(row!);
}

const MAX_TOOL_OUTPUT = 20_000;
/** How long a server's tool list is trusted before it is read again. */
const TOOLS_FRESH_MS = 6 * 60 * 60 * 1000;
const toolsReadAt = new Map<string, number>();

/**
 * Runs one request against a server, refreshing the sign-in once if the server refuses the token.
 * Why: a token can be revoked or expire before the time it was issued for, and
 * the first sign of that is a 401. With a refresh token on file that is recoverable.
 */
async function withBearer<T>(
  db: Database,
  row: { id: string; secret: string; kind: string },
  run: (bearer: string) => Promise<T>,
  fetchImpl?: typeof fetch,
): Promise<T> {
  try {
    return await run(await bearerForRow(db, row, false, fetchImpl));
  } catch (error) {
    if (!(error instanceof McpAuthError)) throw error;
    const [latest] = await db.select({ id: mcpServers.id, secret: mcpServers.secret, kind: mcpServers.kind }).from(mcpServers).where(eq(mcpServers.id, row.id));
    if (!latest || !readSecret(latest.secret).oauth?.refreshToken) throw error;
    return run(await bearerForRow(db, latest, true, fetchImpl));
  }
}

/**
 * Reads a server's tool list again when the stored copy is old.
 * Why: the list was read once, when the server was added, so tools the server
 * gained or dropped later were never noticed. Runs in the background; the
 * turn in progress keeps the list it has.
 * Input: database and the account's server rows.
 */
export function refreshStaleMcpTools(db: Database, rows: (typeof mcpServers.$inferSelect)[], force = false): void {
  for (const row of rows) {
    if (row.kind !== "remote") continue;
    const last = toolsReadAt.get(row.id) ?? 0;
    if (!force && Date.now() - last < TOOLS_FRESH_MS) continue;
    toolsReadAt.set(row.id, Date.now());
    void withBearer(db, row, (bearer) => listMcpTools(row.url, bearer))
      .then((tools) =>
        db
          .update(mcpServers)
          .set({ toolsCache: tools, lastError: tools.length === 0 ? NO_TOOLS : null })
          .where(eq(mcpServers.id, row.id)),
      )
      // The old list is kept: a server that is briefly down should not lose its tools.
      .catch((error: unknown) =>
        db
          .update(mcpServers)
          .set({ lastError: error instanceof Error ? error.message : "Could not reach the MCP server." })
          .where(eq(mcpServers.id, row.id))
          .catch(() => undefined),
      );
  }
}

/**
 * Calls one tool on an account's custom MCP server.
 * Why the row is read again here: a long turn can outlive an access token.
 * Reading the stored secret at call time uses the newest token, and a refresh
 * made by an earlier call is not repeated with a refresh token already spent.
 * Input: database, account id, server slug, tool name and arguments.
 * Output: the result as text, or a plain sentence when the call failed.
 */
export async function runMcpTool(
  db: Database,
  accountId: string,
  slug: string,
  toolName: string,
  args: Record<string, unknown>,
  /** Stands in for the network in tests. */
  fetchImpl?: typeof fetch,
): Promise<string> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug), eq(mcpServers.enabled, true)));
  if (!row || row.kind !== "remote") return `No MCP server named ${slug} is connected.`;
  try {
    const result = await withBearer(db, row, (bearer) => callMcpTool(row.url, bearer, toolName, args, fetchImpl), fetchImpl);
    const { text } = toolResultText(result);
    return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated]` : text;
  } catch (error) {
    if (error instanceof McpAuthError) return `The ${slug} plugin's sign-in is no longer accepted. Ask the person to connect it again in Plugins.`;
    return `The call failed: ${error instanceof Error ? error.message : "the MCP server did not answer."}`;
  }
}

async function bearerForRow(
  db: Database,
  row: { id: string; secret: string; kind: string },
  forceRefresh = false,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (row.kind !== "remote") return "";
  const opened = readSecret(row.secret);
  if (!opened.oauth) return opened.bearer;
  if (opened.bearer && !forceRefresh) return opened.bearer;
  if (!opened.oauth.refreshToken || !row.id) return opened.oauth.accessToken;
  const next = await refreshOAuthSecret(opened.oauth, fetchImpl);
  await updateOAuthSecret(db, row.id, next);
  return next.accessToken;
}
