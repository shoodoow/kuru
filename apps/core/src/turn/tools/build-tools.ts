import { kindHasTool, type WorkerKind } from "../../rooms/worker-kinds.js";
import type { WorkerQuestion } from "../../rooms/worker-questions.js";
import { jsonSchema, tool, type Schema, type ToolSet } from "ai";
import { toolsForSurface, type ToolDefinition } from "@kuru/agent-tools";
import type { getDb } from "../../db/client.js";
import { readHistory } from "../../memory/memory.js";
import { readSkillForAgent } from "../../skills/agent-skills.js";
import { linuxToolExecutes, DISPATCHER_FETCH_CHARS } from "../../computer/linux-tool-executes.js";
import type { AgentMode } from "../types.js";
import type { ToolContext } from "./context.js";
import { dispatcherExecutors, executeDelegate, executeListSkills, executeRefreshSkills } from "./executors.js";
import { wrapToolExecute } from "./wrap-tool-execute.js";
import { optionalPrompt, prompt } from "../../prompt/prompts.js";

/** OpenAI-compatible empty tool input (avoids Zod→JSON Schema propertyNames warnings). */
const NO_PARAMETERS_TOOLS = new Set([
  "list_groups",
  "list_team",
  "list_routines",
  "todo_list",
  "computer_screenshot",
  "list_skills",
  "refresh_skills",
  "browser_list_pages",
  "browser_back",
  "browser_reload",
  "browser_screenshot",
]);

const emptyParametersSchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function sdkInputSchema(def: ToolDefinition): Schema<unknown> {
  if (NO_PARAMETERS_TOOLS.has(def.name)) return emptyParametersSchema;
  return def.inputSchema as unknown as Schema<unknown>;
}

export type WorkerToolBuildContext = {
  db: ReturnType<typeof getDb>;
  accountId: string;
  conversationId: string;
  profile: string | null;
  skillsRoot?: string;
  /** When set (live workers), Auto-review wraps bash and posts cards as the parent. */
  review?: ToolContext;
  /** The worker's kind: a kind that only runs commands or reads is not offered the tools for acting on a page. */
  kind?: WorkerKind;
  /** Asks the agent this worker works for; left out, the worker has nobody to ask. */
  ask?: (question: WorkerQuestion) => Promise<string>;
};

/** Wording lives in prompts/tools.md: `# name`, with an optional `# name.worker` variant. */
function descriptionFor(def: ToolDefinition, surface: "dispatcher" | "worker"): string {
  if (surface === "worker") {
    const variant = optionalPrompt("tools", `${def.name}.worker`);
    if (variant) return variant;
  }
  return prompt("tools", def.name);
}

function workerExecute(
  def: ToolDefinition,
  workerCtx: WorkerToolBuildContext,
): (input: Record<string, unknown>) => Promise<unknown> {
  const linux = workerCtx.profile ? linuxToolExecutes(workerCtx.db, workerCtx.accountId, workerCtx.profile, { viewImages: true }) : {};
  if (def.name === "read_history") {
    return async (input) => {
      const rows =
        typeof input.messageId === "string"
          ? await readHistory(workerCtx.db, workerCtx.accountId, workerCtx.conversationId, { messageId: input.messageId })
          : await readHistory(workerCtx.db, workerCtx.accountId, workerCtx.conversationId, {
              search: String(input.search ?? ""),
            });
      return rows.map((row) => ({ id: row.id, body: row.body }));
    };
  }
  if (def.name === "ask_agent") {
    return async (input) => {
      if (!workerCtx.ask) return "There is nobody to ask on this job. Carry on with the most sensible choice and say in your report what you chose.";
      return workerCtx.ask({
        question: String(input.question ?? ""),
        options: Array.isArray(input.options) ? input.options.map(String) : undefined,
        pick: typeof input.pick === "string" ? input.pick : undefined,
      });
    };
  }
  if (def.name === "read_skill") {
    return async (input) => {
      if (!workerCtx.skillsRoot && !workerCtx.profile) return "No skills directory configured.";
      try {
        return await readSkillForAgent(
          {
            skillsRoot: workerCtx.skillsRoot,
            accountId: workerCtx.accountId,
            linuxProfile: workerCtx.profile,
          },
          String(input.name),
        );
      } catch {
        return "Skill not found.";
      }
    };
  }
  if (def.name === "list_skills" || def.name === "refresh_skills") {
    const skillCtx = {
      db: workerCtx.db,
      skillsRoot: workerCtx.skillsRoot,
      accountId: workerCtx.accountId,
      linuxProfile: workerCtx.profile,
    };
    if (def.name === "list_skills") return async (input: Record<string, unknown>) => executeListSkills(skillCtx, input);
    return async () => executeRefreshSkills(skillCtx);
  }
  const linuxFn = linux[def.name];
  if (!linuxFn) throw new Error(`Missing Linux execute for ${def.name}`);
  return linuxFn;
}

function dispatcherExecute(name: string, ctx: ToolContext): (input: Record<string, unknown>) => Promise<unknown> {
  if (name === "delegate") {
    return (input) =>
      executeDelegate(ctx, input, (args) =>
        import("../delegation.js").then((module) => module.runDelegatedTurn(ctx.db, args)),
      );
  }
  const fn = dispatcherExecutors[name];
  if (!fn) throw new Error(`Missing dispatcher execute for ${name}`);
  return (input) => fn(ctx, input);
}

export function buildDispatcherToolSet(mode: AgentMode, ctx: ToolContext): ToolSet {
  const set: Record<string, unknown> = {};
  const linux = ctx.linuxProfile
    ? linuxToolExecutes(ctx.db, ctx.accountId, ctx.linuxProfile, {
        fetchChars: DISPATCHER_FETCH_CHARS,
        // Skill files are the worker's manual. Reading them here burned tens
        // of thousands of tokens per turn and none of it reached the worker.
        skillFilesNote: (path) => prompt("dispatcher", "skill-files", { path }),
      })
    : {};
  for (const def of toolsForSurface("dispatcher")) {
    if (def.name === "spawn_worker" && mode !== "dispatcher") continue;
    const linuxFn = linux[def.name];
    if (linuxFn) {
      set[def.name] = tool({
        description: descriptionFor(def, "dispatcher"),
        inputSchema: sdkInputSchema(def) as never,
        execute: wrapToolExecute(ctx, mode, def.name, linuxFn) as never,
      });
      continue;
    }
    if (!dispatcherExecutors[def.name] && def.name !== "delegate") continue;
    set[def.name] = tool({
      description: descriptionFor(def, "dispatcher"),
      inputSchema: sdkInputSchema(def) as never,
      execute: wrapToolExecute(ctx, mode, def.name, dispatcherExecute(def.name, ctx)) as never,
    });
  }
  return set as ToolSet;
}

export function buildWorkerToolSet(workerCtx: WorkerToolBuildContext): ToolSet {
  const set: Record<string, unknown> = {};
  const defs = toolsForSurface("worker", { hasLinux: !!workerCtx.profile }).filter((def) => kindHasTool(workerCtx.kind, def.name));
  for (const def of defs) {
    const raw = workerExecute(def, workerCtx);
    const execute = workerCtx.review
      ? wrapToolExecute(workerCtx.review, "worker", def.name, raw)
      : raw;
    const base = {
      description: descriptionFor(def, "worker"),
      inputSchema: sdkInputSchema(def) as never,
      execute: execute as never,
    };
    if (def.name === "computer_screenshot") {
      set[def.name] = tool({
        ...base,
        toModelOutput: ({ output }) => screenshotToModelOutput(output),
      });
      continue;
    }
    if (def.name === "read" || def.name === "browser_screenshot") {
      set[def.name] = tool({
        ...base,
        toModelOutput: ({ output }) => readToModelOutput(output),
      });
      continue;
    }
    set[def.name] = tool(base);
  }
  return set as ToolSet;
}

/** A picture read from disk reaches the model as pixels; everything else stays text. */
function readToModelOutput(output: unknown) {
  const image = output as { path?: string; jpegBase64?: string; note?: string } | null;
  if (!image || typeof image !== "object" || !image.jpegBase64) {
    return { type: "text" as const, value: typeof output === "string" ? output : JSON.stringify(output) };
  }
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: `Image ${image.path}. Look at it and say what is actually in the picture.${image.note ? `\n${image.note}` : ""}` },
      { type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: image.jpegBase64 } },
    ],
  };
}

/** Worker sees the pixels; the model transcript keeps path text, not raw base64 JSON. */
function screenshotToModelOutput(output: unknown) {
  if (typeof output === "string") return { type: "text" as const, value: output };
  if (!output || typeof output !== "object") return { type: "text" as const, value: "Screenshot failed." };
  const shot = output as { path?: string; pngBase64?: string; width?: number; height?: number; display?: string };
  if (!shot.pngBase64 || !shot.path) {
    return { type: "text" as const, value: JSON.stringify({ ...shot, pngBase64: undefined }) };
  }
  return {
    type: "content" as const,
    value: [
      {
        type: "text" as const,
        text:
          `Screenshot saved at ${shot.path} (${shot.width ?? "?"}x${shot.height ?? "?"}` +
          `${shot.display ? `, ${shot.display}` : ""}). Describe what you see. ` +
          `Cite this path in Findings — never paste image bytes to the parent.`,
      },
      {
        type: "file" as const,
        mediaType: "image/png",
        data: { type: "data" as const, data: shot.pngBase64 },
      },
    ],
  };
}
