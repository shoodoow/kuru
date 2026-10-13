import {
  DISPATCHER_TOOL_BUDGET_BROWSER_MS,
  DISPATCHER_TOOL_BUDGET_DEFAULT_MS,
  DISPATCHER_TOOL_BUDGET_SHELL_MS,
  DISPATCHER_TOOL_BUDGET_LOCAL_MS,
  DISPATCHER_TOOL_BUDGET_WEB_MS,
} from "../constants.js";

/** Coordination tools must finish; timing them out breaks turns and spawns. */
const DISPATCHER_UNLIMITED_TOOLS = new Set([
  "send_message",
  "spawn_worker",
  "delegate",
  "stop_worker",
  "redirect_worker",
  "check_worker",
  // Starting the desktop and the browser can take longer than a quick lookup.
  "open_on_screen",
]);

const DISPATCHER_LOCAL_IO_TOOLS = new Set(["read", "glob", "grep"]);

const DISPATCHER_WEB_IO_TOOLS = new Set(["web_fetch", "web_search"]);

/** The chat agent's own browser: opening a page may first have to start the desktop. */
const DISPATCHER_BROWSER_TOOLS = new Set(["browser_navigate", "browser_snapshot", "browser_read"]);

/**
 * Wall-clock cap for one dispatcher/delegate tool call, or null = no cap.
 * Why: parent stays a coordinator; workers own long research. Web gets a
 * real budget; spawn/delegate must not race the model.
 */
export function dispatcherToolBudgetMs(toolName: string): number | null {
  if (DISPATCHER_UNLIMITED_TOOLS.has(toolName)) return null;
  if (DISPATCHER_WEB_IO_TOOLS.has(toolName)) return DISPATCHER_TOOL_BUDGET_WEB_MS;
  if (DISPATCHER_LOCAL_IO_TOOLS.has(toolName)) return DISPATCHER_TOOL_BUDGET_LOCAL_MS;
  if (toolName === "bash") return DISPATCHER_TOOL_BUDGET_SHELL_MS;
  if (DISPATCHER_BROWSER_TOOLS.has(toolName)) return DISPATCHER_TOOL_BUDGET_BROWSER_MS;
  return DISPATCHER_TOOL_BUDGET_DEFAULT_MS;
}

export function dispatcherToolBudgetError(budgetMs: number): string {
  const seconds = Math.round(budgetMs / 1000);
  return `Tool exceeded ${seconds}s — use spawn_worker for long work.`;
}
