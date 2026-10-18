/**
 * Tool families a worker loads when its job needs them.
 * Why: every tool's schema is resent on every step. A worker making a video,
 * writing a plan or sorting email carried the 26 browser tools, the desktop
 * tools and every small plugin on each of its 150 steps without touching
 * them. A worker now starts with files, shell, search and skills; the browser,
 * the desktop and each plugin are one small "load" tool until the job asks for
 * them, and turn on from the next step. What the brief or the worker's kind
 * plainly needs starts on, so the common case costs no extra step.
 * DB: none.
 */
import { tool, jsonSchema, type ToolSet } from "ai";
import { prompt } from "../prompt/prompts.js";
import type { ToolContext } from "../turn/tools/context.js";
import { mentionedToUse } from "../turn/tools/mentions.js";
import { LOAD_WHOLE_PLUGIN_MAX } from "../mcp/tools.js";
import type { WorkerKind } from "./worker-kinds.js";

export type ToolFamily = "browser" | "desktop";

/** The enabled-set entry that turns a family on. */
export function familySet(family: ToolFamily): string {
  return `family:${family}`;
}

/** The family a built-in tool belongs to, or null for a tool every worker keeps. */
export function familyOf(name: string): ToolFamily | null {
  if (name.startsWith("browser_")) return "browser";
  if (name === "open_on_screen") return "desktop";
  if (name.startsWith("computer_") && name !== "computer_memory") return "desktop";
  return null;
}

/** Words in a brief that mean the job acts on a web page. */
const BROWSER_WORDS = /\b(browser|chrome|chromium|devtools|log ?in|sign ?in|signed in|click|button|form|fill (in|out)|submit|web ?page|website|web app|dashboard|captcha|checkout|cookie)\b/i;
/** Words in a brief that mean the job drives the desktop. */
const DESKTOP_WORDS = /\b(desktop|screen|screenshot|gui|window|xterm|on the computer'?s? display|press and hold)\b/i;

/**
 * Families that start on for a job.
 * Input: the worker's kind and the brief. Output: the families to turn on now.
 */
export function startingFamilies(kind: WorkerKind | undefined, brief: string): Set<ToolFamily> {
  const on = new Set<ToolFamily>();
  if (kind === "computer") on.add("desktop").add("browser");
  if (kind === "browser") on.add("browser");
  if (BROWSER_WORDS.test(brief)) on.add("browser");
  if (DESKTOP_WORDS.test(brief)) on.add("desktop");
  return on;
}

/**
 * Puts the browser and desktop tools behind a load tool each, and turns on what starts on.
 * Input: the worker's tools (changed in place), its tool context, and the
 * families to start with. Output: the families now on.
 */
export function gateToolFamilies(tools: ToolSet, review: ToolContext, starting: ReadonlySet<ToolFamily>): Set<ToolFamily> {
  const gates = (review.pluginGates ??= new Map());
  const loaders = (review.pluginLoaders ??= new Map());
  const enabled = (review.enabledToolSets ??= new Set());
  const members = new Map<ToolFamily, string[]>();
  for (const name of Object.keys(tools)) {
    const family = familyOf(name);
    if (!family) continue;
    members.set(family, [...(members.get(family) ?? []), name]);
  }
  const on = new Set<ToolFamily>();
  for (const [family, names] of members) {
    const set = familySet(family);
    for (const name of names) gates.set(name, set);
    if (starting.has(family)) {
      enabled.add(set);
      on.add(family);
    }
    const loader = `load_${family}_tools`;
    loaders.set(loader, set);
    (tools as Record<string, unknown>)[loader] = tool({
      description: prompt("worker-rules", `load-${family}`),
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }) as never,
      execute: async () => {
        enabled.add(set);
        return `${names.length} ${family} tools are available from your next step: ${names.join(", ")}.\n\n${prompt("worker-rules", "screen-guide")}`;
      },
    });
  }
  return on;
}

/**
 * Turns on, from the first step, each small plugin the brief names.
 * Why: a job about the person's Gmail or YouTube needs that plugin at once;
 * a step spent loading it would cost a full resend. A large plugin keeps its
 * search loader, since loading it whole is what this avoids.
 * Input: the tool context after the plugins were added, and the brief.
 */
export function startNamedPlugins(review: ToolContext, brief: string): void {
  const gates = review.pluginGates;
  const loaders = review.pluginLoaders;
  if (!gates || !loaders) return;
  const enabled = (review.enabledToolSets ??= new Set());
  for (const set of new Set(loaders.values())) {
    if (!set.startsWith("plugin:")) continue;
    const slug = set.slice("plugin:".length);
    const size = [...gates.values()].filter((value) => value === set).length;
    if (size > 0 && size <= LOAD_WHOLE_PLUGIN_MAX && slug.length >= 3 && mentionedToUse(brief, slug)) enabled.add(set);
  }
}
