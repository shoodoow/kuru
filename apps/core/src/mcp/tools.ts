/**
 * Account-scoped MCP tools for prompts and the AI SDK tool map.
 */
import { jsonSchema, tool } from "ai";
import type { getDb } from "../db/client.js";
import type { ToolContext } from "../turn/tools/context.js";
import { catalogPlugin } from "./catalog.js";
import { runGoogleTool } from "./google-api.js";
import { runSocialTool } from "../social/run.js";
import { socialUsableBy } from "../social/accounts.js";
import { mcpRowsForAccount, refreshStaleMcpTools, runMcpTool } from "./store.js";
import type { McpToolCacheEntry } from "./types.js";

type Db = ReturnType<typeof getDb>;

export function mcpToolOffersFromRows(
  rows: { slug: string; toolsCache: unknown }[],
): { server: string; tools: { name: string; description: string }[] }[] {
  return rows
    .map((row) => {
      const tools = (Array.isArray(row.toolsCache) ? row.toolsCache : []) as McpToolCacheEntry[];
      return {
        server: row.slug,
        tools: tools.map((t) => ({ name: t.name, description: t.description || `MCP ${row.slug}/${t.name}` })),
      };
    })
    .filter((entry) => entry.tools.length > 0)
    .sort((a, b) => a.server.localeCompare(b.server));
}

export async function mcpToolOffers(db: Db, accountId: string) {
  const rows = await mcpRowsForAccount(db, accountId);
  return mcpToolOffersFromRows(rows);
}

function mcpInputSchema(entry: McpToolCacheEntry) {
  if (entry.inputSchema && typeof entry.inputSchema === "object") {
    return jsonSchema(entry.inputSchema as Record<string, unknown>);
  }
  return jsonSchema({ type: "object", properties: {} });
}

/**
 * The name a model sees for a server's tool.
 * Why: providers accept only letters, digits, `_` and `-`, up to 64
 * characters, and refuse the whole request for one bad name. Server tools are
 * often called things like `issues.create` or `files/read`. The server is still
 * called with its own name; this is only the label.
 * Input: the server slug, the tool's own name, and the names already taken.
 */
export function mcpToolName(slug: string, name: string, taken: ReadonlySet<string>): string {
  const base = `${slug}_${name}`.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
  let candidate = base;
  for (let copy = 2; taken.has(candidate); copy += 1) {
    const suffix = `_${copy}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return candidate;
}

/** A plugin with more tools than this is loaded on request instead of sent with every step. */
export const LAZY_PLUGIN_TOOLS = 12;

type ToolExecuteWrap = (
  name: string,
  execute: (input: Record<string, unknown>) => Promise<unknown>,
) => (input: Record<string, unknown>) => Promise<unknown>;

/** Adds this account's MCP tools into an existing tool map (names `{slug}_{tool}`). */
export async function appendMcpTools(
  ctx: ToolContext,
  set: Record<string, unknown>,
  wrapExecute: ToolExecuteWrap,
): Promise<void> {
  const rows = await mcpRowsForAccount(ctx.db, ctx.accountId);
  refreshStaleMcpTools(ctx.db, rows);
  for (const row of rows) {
    const catalog = row.kind === "google" || row.kind === "social" ? catalogPlugin(row.slug) : undefined;
    const tools = catalog?.tools ?? ((Array.isArray(row.toolsCache) ? row.toolsCache : []) as McpToolCacheEntry[]);
    if (tools.length === 0) continue;
    // Instagram and TikTok are offered only to an agent that has an account to act with.
    if (row.kind === "social" && !socialUsableBy(row, ctx.voiceAgentId ?? ctx.agentId)) continue;
    // Every tool's schema is resent on each model step. A plugin with many
    // tools would dominate every request, so it starts as one small "load"
    // tool and its real tools appear once the agent asks for them.
    const lazy = Boolean(ctx.pluginGates && ctx.pluginLoaders) && tools.length > LAZY_PLUGIN_TOOLS;
    const pluginSet = `plugin:${row.slug}`;
    const loaded: string[] = [];
    if (lazy) {
      const loader = mcpToolName(row.slug, "load_tools", new Set(Object.keys(set)));
      ctx.pluginLoaders!.set(loader, pluginSet);
      set[loader] = tool({
        description: `Load the ${tools.length} tools of the ${catalog?.name ?? row.slug} plugin so you can use them for the rest of this turn. It offers: ${tools
          .map((entry) => entry.name)
          .join(", ")
          .slice(0, 900)}.`,
        inputSchema: jsonSchema({ type: "object", properties: {} }) as never,
        execute: wrapExecute(loader, async () => {
          (ctx.enabledToolSets ??= new Set()).add(pluginSet);
          return { loaded: loaded.length, tools: loaded, note: "These tools are available from your next step." };
        }) as never,
      });
    }
    for (const entry of tools) {
      const fullName = mcpToolName(row.slug, entry.name, new Set(Object.keys(set)));
      loaded.push(fullName);
      if (lazy) ctx.pluginGates!.set(fullName, pluginSet);
      // Approval boundary (prompt-level: servers don't annotate read vs
      // write): any external send/publish/delete/pay must be confirmed with
      // the person via send_message first. Code-level gates apply where the
      // action is known-destructive (e.g. delete_group's confirmed flag).
      const askFirst = " If this sends, publishes, deletes, or pays externally, first confirm with the person via send_message and proceed only after yes.";
      set[fullName] = tool({
        description: (entry.description || `MCP ${row.slug}/${entry.name}`) + askFirst,
        inputSchema: mcpInputSchema(entry) as never,
        execute: wrapExecute(fullName, async (input) => {
          if (catalog?.provider === "google") return runGoogleTool(ctx.db, ctx.accountId, row.slug, entry.name, input, ctx.linuxProfile);
          if (catalog) return runSocialTool(ctx.db, { accountId: ctx.accountId, profile: ctx.linuxProfile }, row.slug, entry.name, input, ctx.voiceAgentId ?? ctx.agentId);
          return runMcpTool(ctx.db, ctx.accountId, row.slug, entry.name, input);
        }) as never,
      });
    }
  }
}
