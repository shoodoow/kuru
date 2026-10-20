import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { dispatcherToolBudgetError, dispatcherToolBudgetMs } from "./dispatcher-tool-budget.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import { reviewToolCall, waitForApproval } from "../auto-review.js";
import type { ToolContext } from "./context.js";
import { prompt } from "../../prompt/prompts.js";
import { workEntry } from "../work-log.js";
import { exec } from "../../linux/linux.js";
import { writeFile } from "../../computer/computer.js";
import { RESULT_INLINE_CHARS, ReadCounter, cutResult, resultText, sourceKeys, writtenPaths } from "./result-guard.js";

/** Browser tools that change the open page. */
const PAGE_ACTIONS = /^browser_(click|click_at|fill|type|select|press_key|upload|drag|batch|set_value)$/;

/** Same tool + byte-identical input this many times in a row = a loop, not work. */
export const DOOM_LOOP_THRESHOLD = 3;
/**
 * The most tool calls one model step may make. A real step makes one to four, and filling a
 * long form in one go about a dozen; a model that has lost the thread makes hundreds.
 */
export const MAX_CALLS_PER_STEP = 20;
const TOO_MANY_CALLS = `More than ${MAX_CALLS_PER_STEP} calls in one step. The rest were not run. Make one call, read its result, then decide the next.`;

/** Text: prompts/dispatcher.md. */
export const doomLoopError = (): string => prompt("dispatcher", "doom-loop");

/** Tools that start background work; once one succeeds the dispatcher's turn is over. */
const HANDOFF_TOOLS = new Set(["spawn_worker", "redirect_worker", "delegate"]);

/** Calls whose result cannot change within one turn; a repeat is answered from the transcript. */
const REPEATABLE_READS = new Set(["read", "read_skill", "web_fetch", "glob", "grep"]);

/** Text: prompts/dispatcher.md. */
const alreadyLoaded = (): string => prompt("dispatcher", "already-loaded");

/** What a read-type call looked at, as one short line for a later worker brief. */
function lookedAt(name: string, input: Record<string, unknown>): string | null {
  if (name === "read" && typeof input.path === "string") return input.path;
  if (name === "web_fetch" && typeof input.url === "string") return input.url;
  if (name === "read_skill" && typeof input.name === "string") return `skill ${input.name}`;
  return null;
}

/**
 * A worker's big tool result, cut once as it arrives, with the whole text saved on its computer.
 * Why: see result-guard.ts. Pictures and small results pass through unchanged.
 */
async function keepSmall(ctx: ToolContext, toolCallId: string, result: unknown): Promise<unknown> {
  const text = resultText(result);
  if (text === null || text.length <= RESULT_INLINE_CHARS) return result;
  let savedAt: string | null = null;
  if (ctx.linuxProfile) {
    const dir = `/home/${ctx.linuxProfile}/.cache/tool-results`;
    const path = `${dir}/${toolCallId.slice(0, 8)}.txt`;
    savedAt = await exec(ctx.accountId, ["mkdir", "-p", dir], ctx.linuxProfile)
      .then(() => writeFile(ctx.accountId, ctx.linuxProfile!, path, text))
      .then(() => path)
      .catch(() => null);
  }
  return cutResult(text, savedAt);
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export function wrapToolExecute(
  ctx: ToolContext,
  mode: AgentMode,
  name: string,
  execute: (input: Record<string, unknown>) => Promise<unknown>,
) {
  return async (input: Record<string, unknown>) => {
    const toolCallId = randomUUID();
    let rereadNote: string | null = null;
    const started = performance.now();
    const inputJson = JSON.stringify(input ?? {});
    // A model that has lost the thread can emit hundreds of calls in one step. Past a sensible
    // number they are not run, and they answer in two words, so the junk is not resent on the next step.
    ctx.stepCalls = (ctx.stepCalls ?? 0) + 1;
    if (ctx.stepCalls > MAX_CALLS_PER_STEP) {
      if (!ctx.stuck) {
        await ctx.traceSession?.emit({ type: "tool.call.finish", toolCallId, name, input, outputPreview: tracePreview(TOO_MANY_CALLS), durationMs: 0, error: "too_many_calls" });
      }
      ctx.stuck = true;
      return { error: ctx.stepCalls === MAX_CALLS_PER_STEP + 1 ? TOO_MANY_CALLS : "Ignored." };
    }
    const recent = (ctx.recentCalls ??= []);
    recent.push({ name, input: inputJson });
    if (recent.length > DOOM_LOOP_THRESHOLD) recent.shift();
    if (
      recent.length === DOOM_LOOP_THRESHOLD &&
      recent.every((call) => call.name === name && call.input === inputJson)
    ) {
      const durationMs = Math.round(performance.now() - started);
      // Said once in full. Every repeat after that answers in two words and leaves no trace line.
      const first = !ctx.stuck;
      ctx.stuck = true;
      if (!first) return { error: "Ignored: repeated call." };
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(doomLoopError()),
        durationMs,
        error: "doom_loop",
      });
      return { error: doomLoopError() };
    }
    // A worker that keeps reading the same file or listing has lost track; told once, then not run.
    if (mode === "worker") {
      const reread = (ctx.readCounter ??= new ReadCounter()).record(sourceKeys(name, input ?? {}), name);
      if (reread.action === "refuse") {
        const note = prompt("worker-rules", "reread-refuse", { source: reread.source, times: reread.times - 1 });
        await ctx.traceSession?.emit({ type: "tool.call.finish", toolCallId, name, input, outputPreview: tracePreview(note), durationMs: 0, error: "reread" });
        return { error: note };
      }
      if (reread.action === "remind") rereadNote = prompt("worker-rules", "reread-remind", { source: reread.source, times: reread.times });
    }
    // A read that already succeeded this turn is still in the transcript above;
    // loading it again only resends the same text on every later step.
    const loadKey = `${name}:${inputJson}`;
    if (REPEATABLE_READS.has(name) && ctx.loaded?.has(loadKey)) {
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(alreadyLoaded()),
        durationMs: 0,
        error: "already_loaded",
      });
      return alreadyLoaded();
    }
    await ctx.traceSession?.emit({ type: "tool.call.start", toolCallId, name, input });
    try {
      let reviewed = await reviewToolCall(ctx, name, input ?? {});
      if (!reviewed.allow && ctx.waitOnApproval && reviewed.approvalId && /Auto-review blocked|still waiting|already waiting/.test(reviewed.reason)) {
        // The card is already in the chat. Pause here until the person answers,
        // then carry on with this same call: nothing the worker did is lost.
        await ctx.waitOnApproval.onState?.("waiting");
        const decision = await waitForApproval(ctx.db, ctx.accountId, reviewed.approvalId, {
          signal: ctx.waitOnApproval.signal,
          onTick: () => ctx.waitOnApproval?.onState?.("tick"),
        });
        await ctx.waitOnApproval.onState?.("resumed");
        if (decision === "approved") {
          reviewed = { allow: true };
        } else {
          reviewed = {
            allow: false,
            blocked: true,
            approvalId: reviewed.approvalId,
            reason:
              decision === "denied"
                ? "The person said no to this action. Do not retry it or reshape it. Reach the goal a safer way, or report it under Blockers."
                : "The person did not answer the approval in time. Do not retry this action. Carry on with the rest of the task without it and say so under Blockers.",
          };
        }
      }
      if (!reviewed.allow) {
        const durationMs = Math.round(performance.now() - started);
        await ctx.traceSession?.emit({
          type: "tool.call.finish",
          toolCallId,
          name,
          input,
          outputPreview: tracePreview(reviewed.reason),
          durationMs,
          error: "auto_review",
        });
        return {
          blocked: true,
          approvalId: reviewed.approvalId,
          error: reviewed.reason,
        };
      }
      let result: unknown;
      const budgetMs =
        mode === "dispatcher" || mode === "delegate" ? dispatcherToolBudgetMs(name) : null;
      if (budgetMs != null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            execute(input),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(dispatcherToolBudgetError(budgetMs))), budgetMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        result = await execute(input);
      }
      if (HANDOFF_TOOLS.has(name) && !isToolError(result)) ctx.handedOff = true;
      const failedResult = isToolError(result);
      if (REPEATABLE_READS.has(name) && !failedResult) (ctx.loaded ??= new Set()).add(loadKey);
      (ctx.workEntries ??= []).push(workEntry(name, input ?? {}, result, failedResult));
      const looked = lookedAt(name, input ?? {});
      if (looked) (ctx.touched ??= new Set()).add(looked);
      const durationMs = Math.round(performance.now() - started);
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(result),
        durationMs,
      });
      if (mode === "worker") ctx.readCounter?.changed(writtenPaths(name, input ?? {}));
      if (mode === "worker" && PAGE_ACTIONS.test(name) && !failedResult) ctx.readCounter?.actedOnPage();
      if (mode === "worker" && !failedResult) result = await keepSmall(ctx, toolCallId, result);
      if (rereadNote) return typeof result === "string" ? `${rereadNote}\n\n${result}` : { note: rereadNote, result };
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : "Tool failed.";
      (ctx.workEntries ??= []).push(workEntry(name, input ?? {}, message, true));
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(message),
        durationMs,
        error: message,
      });
      throw error;
    }
  };
}

