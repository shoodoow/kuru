/**
 * Per-chat context + usage payload (plugin-extensible via model-info providers).
 * Why: years-long threads must stay sharp AND visible — the phone shows how
 * much of the window this chat uses and where tokens went, from DB-accurate
 * per-run usage (not trace-log estimates). Context engineering itself is
 * untouched: same RECENT/SUMMARY windows, same fold watermark, same recall.
 * DB: reads agents/conversations/messages/summary_items/runs/delegations.
 */
import { asSchema } from "ai";
import { toolsForSurface } from "@kuru/agent-tools";
import { and, desc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { agents, conversations, delegations, messages, runs, summaryItems } from "../../db/schema.js";
import { buildInstructions } from "../../prompt/build-instructions.js";
import { roomLine } from "../../memory/context.js";
import { RECENT_WINDOW, SUMMARY_WINDOW } from "../constants.js";
import { modelInfoFor } from "./model-info.js";
import { catalogPlugin } from "../../mcp/catalog.js";
import { mcpRowsForAccount } from "../../mcp/store.js";
import { LAZY_PLUGIN_TOOLS } from "../../mcp/tools.js";
import type { McpToolCacheEntry } from "../../mcp/types.js";
import { optionalPrompt } from "../../prompt/prompts.js";
import { skillCatalogForAgent } from "../../skills/agent-skills.js";
import { activeDispatcherTools, allowedForKind, initialToolSets } from "../tools/tool-sets.js";

type Db = ReturnType<typeof getDb>;

/** Rough chars→tokens for display. Images are not counted. */
const CHARS_PER_TOKEN = 4;

/**
 * Sizes the tools sent with every model step: each one's name, description and input schema.
 * Why: the tool list is resent on every step and is often larger than the
 * conversation itself, so a size without it read far too low.
 * Input: the account, the agent's kind, the room kind, and whether the account
 * has other agents. Output: characters and counts for built-in and connector tools.
 */
async function toolSizes(
  db: Db,
  accountId: string,
  input: { agentKind?: string | null; roomKind: string; hasTeam: boolean },
): Promise<{ toolChars: number; toolCount: number; mcpToolChars: number; mcpToolCount: number }> {
  const definitions = toolsForSurface("dispatcher");
  const allowed = allowedForKind(input.agentKind);
  // The sets a chat starts with. Sets the agent turns on mid-turn are not counted.
  const enabled = new Set<string>(initialToolSets({ agentKind: input.agentKind, roomKind: input.roomKind, hasTeam: input.hasTeam, hasRoutines: false }));
  const active = new Set(activeDispatcherTools(definitions.map((def) => def.name), enabled).filter((name) => !allowed || allowed.includes(name)));
  let toolChars = 0;
  for (const def of definitions) {
    if (!active.has(def.name)) continue;
    toolChars += def.name.length + (optionalPrompt("tools", def.name)?.length ?? 0) + schemaChars(() => asSchema(def.inputSchema as never).jsonSchema);
  }
  let mcpToolChars = 0;
  let mcpToolCount = 0;
  // A restricted kind (companion, support) is never given connector tools.
  const rows = allowed ? [] : await mcpRowsForAccount(db, accountId).catch(() => []);
  for (const row of rows) {
    const tools = (row.kind === "google" ? catalogPlugin(row.slug)?.tools : undefined) ?? ((Array.isArray(row.toolsCache) ? row.toolsCache : []) as McpToolCacheEntry[]);
    if (tools.length === 0) continue;
    if (tools.length > LAZY_PLUGIN_TOOLS) {
      // A large plugin is one small "load" tool until the agent asks for the rest.
      mcpToolCount += 1;
      mcpToolChars += 120 + Math.min(900, tools.map((entry) => entry.name).join(", ").length);
      continue;
    }
    for (const entry of tools) {
      mcpToolCount += 1;
      mcpToolChars += row.slug.length + entry.name.length + (entry.description?.length ?? 0) + schemaChars(() => entry.inputSchema ?? {});
    }
  }
  return { toolChars, toolCount: active.size, mcpToolChars, mcpToolCount };
}

/** Length of a schema as the JSON a provider receives; 0 when it cannot be turned into JSON. */
function schemaChars(read: () => unknown): number {
  try {
    return JSON.stringify(read())?.length ?? 0;
  } catch {
    return 0;
  }
}

export type ChatContextInfo = {
  conversationId: string;
  counts: {
    messages: number;
    summaryItems: number;
    runs: number;
    runsDone: number;
    delegationsRunning: number;
    delegationsDone: number;
  };
  context: {
    prefixChars: number;
    tailChars: number;
    /** Built-in tools offered at the start of a turn, and the size of their definitions. */
    toolCount: number;
    toolChars: number;
    /** Connector (MCP and plugin) tools, counted the same way. */
    mcpToolCount: number;
    mcpToolChars: number;
    /** The list of skill names and descriptions in the prompt. */
    skillChars: number;
    /** The size shown on the phone: `measuredTokens` when there is one, else the estimate. */
    estTokens: number;
    /** What the provider counted per model call on the last run: everything sent, tools included. Null before the first run. */
    measuredTokens: number | null;
    source: "measured" | "estimate";
    recentWindow: number;
    summaryWindow: number;
  };
  usage: {
    runsTracked: number;
    runsUntracked: number;
    delegationsTracked: number;
    delegationsUntracked: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    lastRuns: {
      id: string;
      status: string;
      inputTokens: number | null;
      outputTokens: number | null;
      modelSteps: number | null;
      createdAt: string;
    }[];
  };
  model: {
    provider: string;
    modelId: string;
    contextWindow: number | null;
    capacitySource: "gateway" | "plugin" | "builtin-estimate" | "unknown";
    /** Share of window one estimated turn occupies, or null when unknown. */
    estTurnShare: number | null;
  };
};

export async function buildChatContextInfo(
  db: Db,
  accountId: string,
  conversationId: string,
  opts?: { skillsRoot?: string },
): Promise<ChatContextInfo | null> {
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) return null;
  const [owner] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, room.ownerAgentId), eq(agents.accountId, accountId)));

  const prefixChars = owner
    ? buildInstructions({
        name: owner.name,
        role: owner.role,
        personality: owner.personality,
        job: owner.jobDescription,
      }).length
    : 0;

  const recent = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_WINDOW);
  const summary = await db
    .select({ key: summaryItems.key, body: summaryItems.body })
    .from(summaryItems)
    .where(and(eq(summaryItems.conversationId, conversationId), eq(summaryItems.accountId, accountId)))
    .orderBy(desc(summaryItems.createdAt))
    .limit(SUMMARY_WINDOW);
  const memberCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)));

  const roomHeader = roomLine({
    title: room.title,
    kind: room.kind,
    members: [],
    selfName: owner?.name ?? "?",
  }).length;
  const tailChars =
    roomHeader + summary.reduce((n, item) => n + item.key.length + item.body.length + 2, 0) +
    recent.reduce((n, row) => n + row.body.length + 1, 0);

  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.accountId, accountId)))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  const delegationRows = await db
    .select({
      status: delegations.status,
      inputTokens: delegations.inputTokens,
      outputTokens: delegations.outputTokens,
      cacheReadTokens: delegations.cacheReadTokens,
    })
    .from(delegations)
    .where(and(eq(delegations.conversationId, conversationId), eq(delegations.accountId, accountId)));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let tracked = 0;
  for (const row of runRows) {
    if (row.inputTokens !== null || row.outputTokens !== null) {
      tracked += 1;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      cacheReadTokens += row.cacheReadTokens ?? 0;
    }
  }
  // Workers bill separately (up to 10 screenshot steps each) — without this
  // the display understates the provider dashboard by an order of magnitude.
  let delegationsTracked = 0;
  for (const row of delegationRows) {
    if (row.inputTokens !== null || row.outputTokens !== null) {
      delegationsTracked += 1;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      cacheReadTokens += row.cacheReadTokens ?? 0;
    }
  }

  const provider = owner?.provider ?? "unknown";
  const modelId = owner?.modelId ?? "unknown";
  const capacity = modelInfoFor(provider, modelId, owner?.modelContextWindow);
  const [others] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), eq(agents.hidden, false)));
  const tools = await toolSizes(db, accountId, { agentKind: owner?.kind, roomKind: room.kind, hasTeam: (others?.count ?? 0) > 1 });
  const skillChars = owner
    ? (await skillCatalogForAgent({ skillsRoot: opts?.skillsRoot, accountId, linuxProfile: owner.linuxProfile }).catch(() => [])).reduce(
        (n, skill) => n + skill.name.length + skill.description.length + 4,
        0,
      )
    : 0;
  const estimated = Math.ceil((prefixChars + tailChars + tools.toolChars + tools.mcpToolChars + skillChars) / CHARS_PER_TOKEN);
  // A run adds up the input of each model call, so input / calls is one call's prompt as the provider counted it.
  const lastTracked = runRows.find((row) => (row.inputTokens ?? 0) > 0 && (row.modelSteps ?? 0) > 0);
  const measuredTokens = lastTracked ? Math.round((lastTracked.inputTokens ?? 0) / (lastTracked.modelSteps ?? 1)) : null;
  const estTokens = measuredTokens ?? estimated;

  return {
    conversationId,
    counts: {
      messages: Number(memberCount[0]?.count ?? recent.length),
      summaryItems: summary.length,
      runs: runRows.length,
      runsDone: runRows.filter((row) => row.status === "done").length,
      delegationsRunning: delegationRows.filter((row) => row.status === "running").length,
      delegationsDone: delegationRows.filter((row) => row.status === "done").length,
    },
    context: {
      prefixChars,
      tailChars,
      toolCount: tools.toolCount,
      toolChars: tools.toolChars,
      mcpToolCount: tools.mcpToolCount,
      mcpToolChars: tools.mcpToolChars,
      skillChars,
      estTokens,
      measuredTokens,
      source: measuredTokens === null ? "estimate" : "measured",
      recentWindow: RECENT_WINDOW,
      summaryWindow: SUMMARY_WINDOW,
    },
    usage: {
      runsTracked: tracked,
      runsUntracked: runRows.length - tracked,
      delegationsTracked,
      delegationsUntracked: delegationRows.length - delegationsTracked,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens,
      lastRuns: runRows.slice(0, 10).map((row) => ({
        id: row.id,
        status: row.status,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        modelSteps: row.modelSteps,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    model: {
      provider,
      modelId,
      contextWindow: capacity.contextWindow,
      capacitySource: capacity.source,
      estTurnShare: capacity.contextWindow ? estTokens / capacity.contextWindow : null,
    },
  };
}
