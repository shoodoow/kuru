/**
 * Optional dispatcher tool sets (team, routines, admin).
 * Why: tool schemas are resent on every model step, and most turns in a
 * private chat never touch groups or schedules. A set is on from the start
 * when the room already uses it; otherwise the model turns it on with
 * `enable_tools`. Wording lives in prompts/tool-sets.md. DB: none.
 */
import {
  requestableToolSetNames,
  toolNamesInSet,
  toolSetNames,
  toolsForSurface,
  type ToolSetName,
} from "@kuru/agent-tools";
import { prompt } from "../../prompt/prompts.js";


const gatedBy = new Map<string, ToolSetName>(
  toolsForSurface("dispatcher")
    .filter((def) => def.set)
    .map((def) => [def.name, def.set!] as const),
);

export function isToolSetName(value: string): value is ToolSetName {
  return (toolSetNames as readonly string[]).includes(value);
}

/** True for a set an agent may turn on itself. `support` is never one of them. */
export function isRequestableToolSet(value: string): value is ToolSetName {
  return (requestableToolSetNames as readonly string[]).includes(value);
}

/**
 * Picks the tools offered on one model step.
 * Input: every registered tool name and the sets that are on.
 * Output: ungated tools (built-ins, connectors, plugins) plus the enabled
 * sets. `enable_tools` disappears once nothing is left to enable.
 */
export function activeDispatcherTools(
  allNames: string[],
  enabled: ReadonlySet<string>,
  blocked: ReadonlySet<string> = new Set(),
  plugins?: { gates?: ReadonlyMap<string, string>; loaders?: ReadonlyMap<string, string> },
): string[] {
  const allOn = requestableToolSetNames.every((set) => enabled.has(set));
  return allNames.filter((name) => {
    if (blocked.has(name)) return false;
    if (name === "enable_tools") return !allOn;
    const plugin = pluginToolActive(name, enabled, plugins);
    if (plugin !== undefined) return plugin;
    const set = gatedBy.get(name);
    return !set || enabled.has(set);
  });
}

/** The enabled-set entry that turns on one tool of a lazy plugin. */
export function pluginToolKey(fullName: string): string {
  return `tool:${fullName}`;
}

/**
 * Whether one tool of a lazy plugin is offered now, or undefined for a tool that is not a plugin's.
 * A large plugin shows one "load" tool until it is loaded whole; its real
 * tools appear when the whole plugin, or that one tool, was loaded.
 */
function pluginToolActive(
  name: string,
  enabled: ReadonlySet<string>,
  plugins?: { gates?: ReadonlyMap<string, string>; loaders?: ReadonlyMap<string, string> },
): boolean | undefined {
  const loads = plugins?.loaders?.get(name);
  if (loads) return !enabled.has(loads);
  const plugin = plugins?.gates?.get(name);
  if (plugin) return enabled.has(plugin) || enabled.has(pluginToolKey(name));
  return undefined;
}

/**
 * Picks a worker's tools for one step: everything except plugin tools it has not loaded.
 * Why: a worker used to carry every tool of every connected plugin on every
 * step. One email plugin with 137 tools added about 110,000 tokens to each.
 */
export function activeWorkerTools(
  allNames: string[],
  enabled: ReadonlySet<string>,
  plugins: { gates?: ReadonlyMap<string, string>; loaders?: ReadonlyMap<string, string> },
): string[] {
  return allNames.filter((name) => pluginToolActive(name, enabled, plugins) ?? true);
}

/** Most tool names one deferred-tools block lists, so a huge plugin cannot flood the prompt. */
const DEFERRED_NAMES_MAX = 300;
/** A plugin with more deferred tools than this is listed on one line, its shared prefix said once. */
const COMPACT_NAMES_FROM = 20;

/** The start every name shares up to and including its last `_`, or "" when they share none. */
function sharedPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0] ?? "";
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf("_");
  return cut > 0 ? prefix.slice(0, cut + 1) : "";
}

/**
 * The names of a worker's tools that are not loaded yet, grouped by the tool that loads them.
 * Why: a worker saw only a few plugin tool names and loaded by keyword search,
 * which turned on 12 tools at a time; one run carried 24 email tools on every
 * step and used 3. With exact names it loads only what it needs.
 * A big plugin the job does not name gets one line: its names cost every step
 * and the loader's `search` finds the few a job needs. A Reddit job carried
 * 3,500 characters of YouTube and email tool names on each of its 77 steps.
 * Input: gates (tool → set), loaders (loader → set), the sets that are on,
 * and the job's text (a plugin named in it keeps its full list of names).
 * Output: an `<available-deferred-tools>` block, or "" when nothing is deferred.
 */
export function deferredToolsBlock(
  gates: ReadonlyMap<string, string>,
  loaders: ReadonlyMap<string, string>,
  enabled: ReadonlySet<string>,
  jobText?: string,
): string {
  const job = jobText?.toLowerCase();
  const loaderOf = new Map<string, string>();
  for (const [loader, set] of loaders) loaderOf.set(set, loader);
  const groups = new Map<string, string[]>();
  for (const [name, set] of gates) {
    if (enabled.has(set) || enabled.has(pluginToolKey(name))) continue;
    groups.set(set, [...(groups.get(set) ?? []), name]);
  }
  if (groups.size === 0) return "";
  let budget = DEFERRED_NAMES_MAX;
  const lines: string[] = [];
  for (const [set, names] of groups) {
    const loader = loaderOf.get(set);
    if (!loader) continue;
    if (set.startsWith("family:")) {
      lines.push(`${set.slice("family:".length)} (${names.length} tools): call ${loader} to load them all`);
      continue;
    }
    const plugin = set.replace(/^plugin:/, "");
    if (job !== undefined && names.length > COMPACT_NAMES_FROM && !job.includes(plugin.toLowerCase())) {
      lines.push(`${plugin} (${names.length} tools): call ${loader} with "search" (what you want to do) to load the ones you need`);
      continue;
    }
    const shown = names.slice(0, Math.max(0, budget));
    budget -= shown.length;
    const prefix = sharedPrefix(shown);
    if (shown.length > COMPACT_NAMES_FROM && prefix) {
      // One line, the shared prefix said once. Why: a Reddit job carried the 140
      // names of the email plugin, one per line, on each of its 125 steps.
      lines.push(`${set.replace(/^plugin:/, "")}: load with ${loader} {"tools": [exact names]}; each name below starts with ${prefix}`);
      lines.push(shown.map((name) => name.slice(prefix.length)).join(", "));
    } else {
      lines.push(`${set.replace(/^plugin:/, "")}: load with ${loader} {"tools": [exact names]}`, ...shown);
    }
    if (shown.length < names.length) lines.push(`(${names.length - shown.length} more; ${loader} with "search" finds them)`);
  }
  return prompt("worker-rules", "deferred-tools", { list: lines.join("\n") });
}

/** How to use one set: returned by enable_tools and added to the prompt when the set starts on. */
export function toolSetGuidance(set: ToolSetName): string {
  return prompt("tool-sets", set);
}

/**
 * Sets that start on for a turn, from what the room already uses.
 * Input: room kind, whether the account has teammates or groups, whether this
 * agent has routines, whether this is a routine wake or a delegated turn.
 */
export function initialToolSets(input: {
  roomKind: string;
  hasTeam: boolean;
  hasRoutines: boolean;
  routineWake?: boolean;
  delegated?: boolean;
  /** A teammate in someone else's group: it hands work on by @mention, not with the lead's tools. */
  teamMember?: boolean;
  /** The agent's kind. Companion and support agents never get the work sets. */
  agentKind?: string | null;
}): ToolSetName[] {
  if (input.agentKind === "support") return ["support"];
  if (input.agentKind === "companion") return [];
  const sets: ToolSetName[] = [];
  if (!input.teamMember && (input.roomKind === "group" || input.hasTeam || input.delegated)) sets.push("team");
  if (input.hasRoutines || input.routineWake) sets.push("routines");
  return sets;
}

export { toolNamesInSet };

/**
 * Tools a teammate does not get in a group it does not lead.
 * Why: given the lead's tools, teammates tried to delegate to invented ids and
 * pinged the person directly. A teammate replies in the chat and names who is next.
 */
export const TEAM_MEMBER_BLOCKED = ["enable_tools", "notify_user"] as const;

/** What an agent kept for conversation can do: talk, remember, look things up, pass a message on. */
const COMPANION_TOOLS = [
  "send_message",
  "react_to_message",
  "remember_fact",
  "correct_memory",
  "search_memory",
  "read_history",
  "web_search",
  "web_fetch",
  "message_agent",
] as const;

/**
 * The only tools an agent of a restricted kind has, or undefined for a work agent.
 * Why: an allow list, so a connector or plugin added later is left out by
 * default. That is what keeps the support agent from doing the work itself
 * and a companion from starting jobs.
 */
export function allowedForKind(kind?: string | null): readonly string[] | undefined {
  if (kind === "companion") return COMPANION_TOOLS;
  if (kind === "support") return [...COMPANION_TOOLS, ...toolNamesInSet("support")];
  return undefined;
}
