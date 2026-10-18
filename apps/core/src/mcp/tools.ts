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
import { pluginToolKey } from "../turn/tools/tool-sets.js";

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
    return jsonSchema(clipSchemaDescriptions(entry.inputSchema) as Record<string, unknown>);
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
/** A lazy plugin this small loads whole; a larger one loads only the tools asked for. */
export const LOAD_WHOLE_PLUGIN_MAX = 30;
/** Most tools one load call turns on, so a large plugin can never flood the prompt. */
export const LOAD_TOOLS_PER_CALL = 12;
/** Longest description a connector tool may send with every step. */
export const MCP_DESCRIPTION_CHARS = 500;
/** Longest description inside a connector tool's input schema. */
const MCP_SCHEMA_DESCRIPTION_CHARS = 160;

/**
 * Shortens every description inside a JSON schema.
 * Why: some servers put pages of documentation in their schemas, and the
 * schema is resent on every model step. One server sent 400,000 characters.
 */
export function clipSchemaDescriptions(schema: unknown, limit = MCP_SCHEMA_DESCRIPTION_CHARS): unknown {
  if (Array.isArray(schema)) return schema.map((item) => clipSchemaDescriptions(item, limit));
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] =
      key === "description" && typeof value === "string" && value.length > limit
        ? `${value.slice(0, limit - 1)}…`
        : clipSchemaDescriptions(value, limit);
  }
  return out;
}

/** The first sentence of a description, for a one-line catalog entry. */
function firstLine(text: string, limit = 90): string {
  const line = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Tools of a plugin that best match a search, best first.
 * Input: the plugin's tools and the words asked for. Output: up to `limit` entries.
 */
export function matchPluginTools(tools: McpToolCacheEntry[], search: string, limit = LOAD_TOOLS_PER_CALL): McpToolCacheEntry[] {
  const words = search.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (words.length === 0) return [];
  const scored = tools.map((entry, index) => {
    const name = entry.name.toLowerCase();
    const description = (entry.description ?? "").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 3;
      else if (description.includes(word)) score += 1;
    }
    return { entry, index, score };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((row) => row.entry);
}

function clipDescription(text: string): string {
  return text.length > MCP_DESCRIPTION_CHARS ? `${text.slice(0, MCP_DESCRIPTION_CHARS - 1)}…` : text;
}

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
    // tool and its real tools appear once the agent asks for them. A caller
    // with no gates (a test, a one-off) gets every tool.
    const lazy = Boolean(ctx.pluginGates && ctx.pluginLoaders) && tools.length > LAZY_PLUGIN_TOOLS;
    const pluginSet = `plugin:${row.slug}`;
    const pluginName = catalog?.name ?? row.slug;
    /** The name the model sees for each of the server's tools. */
    const fullNames = new Map<string, string>();
    {
      const taken = new Set(Object.keys(set));
      if (lazy) taken.add(mcpToolName(row.slug, "load_tools", taken));
      for (const entry of tools) {
        const fullName = mcpToolName(row.slug, entry.name, taken);
        taken.add(fullName);
        fullNames.set(entry.name, fullName);
      }
    }
    if (lazy) {
      const loader = mcpToolName(row.slug, "load_tools", new Set(Object.keys(set)));
      ctx.pluginLoaders!.set(loader, pluginSet);
      const whole = tools.length <= LOAD_WHOLE_PLUGIN_MAX;
      const catalogLine = (entry: McpToolCacheEntry) => `${fullNames.get(entry.name)}${entry.description ? ` — ${firstLine(entry.description)}` : ""}`;
      set[loader] = tool({
        description: whole
          ? `Load the ${tools.length} tools of the ${pluginName} plugin so you can use them from your next step. It offers: ${tools
              .map((entry) => entry.name)
              .join(", ")
              .slice(0, 900)}.`
          : `The ${pluginName} plugin has ${tools.length} tools, too many to load at once. Pass \`search\` (what you want to do, e.g. "send email", "list domains") to load the best matches, or \`tools\` (exact names from an earlier search). At most ${LOAD_TOOLS_PER_CALL} per call; they are usable from your next step. Some of its tools: ${tools
              .map((entry) => entry.name)
              .join(", ")
              .slice(0, 400)}…`,
        inputSchema: jsonSchema(
          whole
            ? { type: "object", properties: {} }
            : {
                type: "object",
                properties: {
                  search: { type: "string", description: "What you want to do with the plugin." },
                  tools: { type: "array", items: { type: "string" }, description: "Exact tool names to load." },
                },
              },
        ) as never,
        execute: wrapExecute(loader, async (input) => {
          const enabled = (ctx.enabledToolSets ??= new Set());
          if (whole) {
            enabled.add(pluginSet);
            return { loaded: tools.length, tools: [...fullNames.values()], note: "These tools are available from your next step." };
          }
          const asked = Array.isArray(input.tools) ? input.tools.map(String) : [];
          const byName = asked.length
            ? tools.filter((entry) => asked.includes(entry.name) || asked.includes(fullNames.get(entry.name) ?? ""))
            : [];
          const chosen = (byName.length > 0 ? byName : matchPluginTools(tools, typeof input.search === "string" ? input.search : "")).slice(
            0,
            LOAD_TOOLS_PER_CALL,
          );
          if (chosen.length === 0) {
            return {
              loaded: 0,
              note: `Nothing matched. Call again with \`search\` naming the action, or \`tools\` with names from this list.`,
              available: tools.map(catalogLine).join("\n").slice(0, 6_000),
            };
          }
          for (const entry of chosen) enabled.add(pluginToolKey(fullNames.get(entry.name)!));
          return {
            loaded: chosen.length,
            tools: chosen.map(catalogLine),
            note: "These tools are available from your next step. Load others the same way if you need them.",
          };
        }) as never,
      });
    }
    for (const entry of tools) {
      const fullName = fullNames.get(entry.name)!;
      if (lazy) ctx.pluginGates!.set(fullName, pluginSet);
      // Approval boundary (prompt-level: servers don't annotate read vs
      // write): any external send/publish/delete/pay must be confirmed with
      // the person via send_message first. Code-level gates apply where the
      // action is known-destructive (e.g. delete_group's confirmed flag).
      const askFirst = " If this sends, publishes, deletes, or pays externally, first confirm with the person via send_message and proceed only after yes.";
      set[fullName] = tool({
        description: clipDescription(entry.description || `MCP ${row.slug}/${entry.name}`) + askFirst,
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
