/**
 * AI SDK tool map for dispatcher/delegate turns: tool({ description, inputSchema, execute }).
 */
import { tool, type ToolSet } from "ai";
import { dispatcherToolNames as agentDispatcherToolNames } from "@kuru/agent-tools";
import type { AgentMode } from "../types.js";
import type { ToolContext } from "./context.js";
import { buildDispatcherToolSet } from "./build-tools.js";
import { appendMcpTools } from "../../mcp/tools.js";
import { listPluginToolsForMode } from "../plugins/registry.js";
import { wrapToolExecute } from "./wrap-tool-execute.js";

export { wrapToolExecute } from "./wrap-tool-execute.js";

/** Sorted built-in dispatcher tool names. */
export function dispatcherToolNames(): string[] {
  return agentDispatcherToolNames();
}

export function buildToolSet(mode: AgentMode, ctx: ToolContext): ToolSet {
  const set = buildDispatcherToolSet(mode, ctx) as Record<string, unknown>;
  for (const plugin of listPluginToolsForMode(mode)) {
    set[plugin.fullName] = tool({
      description: plugin.description,
      inputSchema: plugin.inputSchema as never,
      execute: wrapToolExecute(ctx, mode, plugin.fullName, (input) => plugin.execute(ctx, input)) as never,
    });
  }
  return set as ToolSet;
}

export async function buildFullToolSet(mode: AgentMode, ctx: ToolContext): Promise<ToolSet> {
  const set = buildToolSet(mode, ctx) as Record<string, unknown>;
  await appendMcpTools(ctx, set, (name, execute) => wrapToolExecute(ctx, mode, name, execute));
  return set as ToolSet;
}
