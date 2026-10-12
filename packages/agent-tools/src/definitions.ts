import type { z } from "zod";
import {
  bashInputSchema,
  searchMemoryInputSchema,
  enableToolsInputSchema,
  delegateSchema,
  emptyToolInputSchema,
  globInputSchema,
  grepInputSchema,
  groupConversationInputSchema,
  groupCreateInputSchema,
  teamBriefInputSchema,
  ownProfileInputSchema,
  accountBriefInputSchema,
  hireAgentInputSchema,
  agentMemoryReadInputSchema,
  agentMemoryAddInputSchema,
  agentMemoryCorrectInputSchema,
  messageAgentInputSchema,
  keyInputSchema,
  computerMemoryInputSchema,
  memberAddInputSchema,
  notifyInputSchema,
  reactionSchema,
  rememberFactToolInputSchema,
  correctMemoryToolInputSchema,
  readHistoryToolInputSchema,
  readSkillToolInputSchema,
  deleteRoutinesInputSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageToolInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  teammateUpdateSchema,
  todoWriteInputSchema,
  typeTextInputSchema,
  urlInputSchema,
  webSearchInputSchema,
  workerCheckInputSchema,
  workerRedirectInputSchema,
  workerRefInputSchema,
  xyInputSchema,
  pathInputSchema,
  readWriteInputSchema,
  browserNavigateInputSchema,
  openOnScreenInputSchema,
  browserUidInputSchema,
  browserFillInputSchema,
  browserPressKeyInputSchema,
  browserDialogInputSchema,
  browserWaitInputSchema,
} from "./schemas.js";

export type ToolSurface = "dispatcher" | "worker";

/**
 * Optional dispatcher tool sets. A tool with no set is always offered; a tool
 * in a set is offered only when that set is on for the turn, which keeps the
 * schemas resent on every model step small.
 */
export const toolSetNames = ["team", "routines", "admin", "support"] as const;
export type ToolSetName = (typeof toolSetNames)[number];

/** Sets an agent may turn on with `enable_tools`. `support` belongs to the account's default agent only. */
export const requestableToolSetNames = ["team", "routines", "admin"] as const satisfies readonly ToolSetName[];

/**
 * One tool's name, where it is offered, and its input shape.
 * The wording the model reads lives in `prompts/tools.md`, keyed by name.
 */
export type ToolDefinition = {
  name: string;
  surfaces: ToolSurface[];
  requiresLinux?: boolean;
  inputSchema: z.ZodType;
  /** Dispatcher-only gate; workers ignore it. */
  set?: ToolSetName;
};

export const allToolDefinitions: ToolDefinition[] = [
  {
    name: "add_to_group",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: memberAddInputSchema,
  },
  {
    name: "create_group",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: groupCreateInputSchema,
  },
  {
    name: "message_agent",
    surfaces: ["dispatcher"],
    inputSchema: messageAgentInputSchema,
  },
  {
    name: "set_team_brief",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: teamBriefInputSchema,
  },
  {
    name: "set_my_profile",
    surfaces: ["dispatcher"],
    inputSchema: ownProfileInputSchema,
  },
  {
    name: "set_brief",
    set: "support",
    surfaces: ["dispatcher"],
    inputSchema: accountBriefInputSchema,
  },
  {
    name: "hire_agent",
    set: "support",
    surfaces: ["dispatcher"],
    inputSchema: hireAgentInputSchema,
  },
  {
    name: "read_agent_memory",
    set: "support",
    surfaces: ["dispatcher"],
    inputSchema: agentMemoryReadInputSchema,
  },
  {
    name: "remember_for_agent",
    set: "support",
    surfaces: ["dispatcher"],
    inputSchema: agentMemoryAddInputSchema,
  },
  {
    name: "correct_agent_memory",
    set: "support",
    surfaces: ["dispatcher"],
    inputSchema: agentMemoryCorrectInputSchema,
  },
  {
    name: "create_routine",
    set: "routines",
    surfaces: ["dispatcher"],
    inputSchema: routineCreateInputSchema,
  },
  {
    name: "delegate",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: delegateSchema,
  },
  {
    name: "delete_group",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: groupConversationInputSchema,
  },
  {
    name: "delete_routine",
    set: "routines",
    surfaces: ["dispatcher"],
    inputSchema: routineIdSchema,
  },
  {
    name: "delete_routines",
    set: "routines",
    surfaces: ["dispatcher"],
    inputSchema: deleteRoutinesInputSchema,
  },
  {
    name: "hire_subagent",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: subagentCreateSchema,
  },
  {
    name: "update_teammate",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: teammateUpdateSchema,
  },
  {
    name: "list_groups",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "list_routines",
    set: "routines",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "list_team",
    set: "team",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "notify_user",
    surfaces: ["dispatcher"],
    inputSchema: notifyInputSchema,
  },
  {
    name: "react_to_message",
    surfaces: ["dispatcher"],
    inputSchema: reactionSchema,
  },
  {
    name: "read_history",
    surfaces: ["dispatcher", "worker"],
    inputSchema: readHistoryToolInputSchema,
  },
  {
    name: "search_memory",
    surfaces: ["dispatcher"],
    inputSchema: searchMemoryInputSchema,
  },
  {
    name: "remember_fact",
    surfaces: ["dispatcher"],
    inputSchema: rememberFactToolInputSchema,
  },
  {
    name: "correct_memory",
    surfaces: ["dispatcher"],
    inputSchema: correctMemoryToolInputSchema,
  },
  {
    name: "read_skill",
    surfaces: ["dispatcher", "worker"],
    inputSchema: readSkillToolInputSchema,
  },
  {
    name: "list_skills",
    set: "admin",
    surfaces: ["dispatcher", "worker"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "refresh_skills",
    set: "admin",
    surfaces: ["dispatcher", "worker"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "send_message",
    surfaces: ["dispatcher"],
    inputSchema: sendMessageToolInputSchema,
  },
  {
    name: "spawn_worker",
    surfaces: ["dispatcher"],
    inputSchema: spawnWorkerToolInputSchema,
  },
  {
    name: "enable_tools",
    surfaces: ["dispatcher"],
    inputSchema: enableToolsInputSchema,
  },
  {
    name: "stop_worker",
    surfaces: ["dispatcher"],
    inputSchema: workerRefInputSchema,
  },
  {
    name: "redirect_worker",
    surfaces: ["dispatcher"],
    inputSchema: workerRedirectInputSchema,
  },
  {
    name: "check_worker",
    surfaces: ["dispatcher"],
    inputSchema: workerCheckInputSchema,
  },
  {
    name: "todo_list",
    set: "admin",
    surfaces: ["dispatcher"],
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "todo_write",
    surfaces: ["dispatcher"],
    inputSchema: todoWriteInputSchema,
  },
  {
    name: "update_routine",
    set: "routines",
    surfaces: ["dispatcher"],
    inputSchema: routineUpdateInputSchema,
  },
  // --- Linux (worker; parent gets read-only cheap tools when a profile exists) ---
  {
    name: "read",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: pathInputSchema,
  },
  {
    name: "write",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: readWriteInputSchema,
  },
  {
    name: "bash",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: bashInputSchema,
  },
  {
    name: "computer_screenshot",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "computer_mouse",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: xyInputSchema,
  },
  {
    name: "computer_click",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: xyInputSchema,
  },
  {
    name: "computer_type",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: typeTextInputSchema,
  },
  {
    name: "computer_key",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: keyInputSchema,
  },
  {
    name: "computer_memory",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: computerMemoryInputSchema,
  },
  {
    name: "web_fetch",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: urlInputSchema,
  },
  {
    name: "web_search",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: webSearchInputSchema,
  },
  {
    name: "glob",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: globInputSchema,
  },
  {
    name: "grep",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: grepInputSchema,
  },
  {
    name: "browser_list_pages",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "browser_navigate",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserNavigateInputSchema,
  },
  {
    name: "open_on_screen",
    surfaces: ["dispatcher", "worker"],
    requiresLinux: true,
    inputSchema: openOnScreenInputSchema,
  },
  {
    name: "browser_snapshot",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: emptyToolInputSchema,
  },
  {
    name: "browser_click",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserUidInputSchema,
  },
  {
    name: "browser_fill",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserFillInputSchema,
  },
  {
    name: "browser_press_key",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserPressKeyInputSchema,
  },
  {
    name: "browser_handle_dialog",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserDialogInputSchema,
  },
  {
    name: "browser_wait_for",
    surfaces: ["worker"],
    requiresLinux: true,
    inputSchema: browserWaitInputSchema,
  },
];

export function toolsForSurface(surface: ToolSurface, opts?: { hasLinux?: boolean }): ToolDefinition[] {
  return allToolDefinitions.filter(
    (t) => t.surfaces.includes(surface) && (surface !== "worker" || !t.requiresLinux || opts?.hasLinux),
  );
}

export function dispatcherToolNames(): string[] {
  return toolsForSurface("dispatcher")
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b));
}

export function workerToolNames(hasLinux: boolean): string[] {
  return toolsForSurface("worker", { hasLinux }).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}

export function toolDefinitionByName(name: string): ToolDefinition | undefined {
  return allToolDefinitions.find((t) => t.name === name);
}

/** Dispatcher tools that belong to one optional set. */
export function toolNamesInSet(set: ToolSetName): string[] {
  return allToolDefinitions.filter((t) => t.set === set && t.surfaces.includes("dispatcher")).map((t) => t.name);
}
