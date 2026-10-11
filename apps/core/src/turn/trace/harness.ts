/**
 * Single AI SDK entry: generateText + trace events.
 * Why: every dispatcher/worker/delegate model call is inspectable via TracePlugin.
 * DB: none (tools write via registry).
 */
import { repairToolInput } from "../tools/repair-input.js";
import { generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";
import { getModel, usesOfficialOpenAiEndpoint } from "../../model/get-model.js";
import { keyFor } from "../../keys/keys.js";
import type { getDb } from "../../db/client.js";
import { toModelPrompt } from "../prompt-model.js";
import type { TurnInput } from "../types.js";
import { DISPATCHER_MAX_OUTPUT_TOKENS, MAX_MODEL_STEPS_DISPATCHER, MAX_MODEL_STEPS_HARD } from "../constants.js";
import { createTraceSession, type TraceSession } from "./plugins.js";
import { tracePreview } from "./sinks/jsonl.js";
import type { AgentMode } from "../types.js";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof getDb>;

export type RunModelInput = TurnInput & {
  db: Db;
  conversationId: string;
  runId: string;
  mode: AgentMode;
  tools: ToolSet;
  delegationId?: string;
  maxSteps?: number;
  /** When set, harness reuses this session (tools emit into the same trace). */
  traceSession?: TraceSession;
  /**
   * Extra stop, checked after every step. Receives the tool names called in
   * each finished step (oldest first) so the caller can decide purely from
   * what already happened.
   */
  shouldStop?: (stepToolNames: string[][]) => boolean;
  /**
   * Per-step tool restriction. Receives how many steps already finished and
   * the step cap; returns the tools to keep plus a note for the model, or
   * null to leave the step unrestricted.
   */
  restrictStep?: (
    finishedSteps: number,
    maxSteps: number,
    stepToolNames: string[][],
  ) => { activeTools: string[]; note: string } | null;
  /** Tools offered on the next step, re-read every step; null offers all of them. */
  activeTools?: () => string[] | null;
  /** "required" makes the model call one of the offered tools instead of answering in text. */
  toolChoice?: "required";
};

/**
 * Accurate usage for one harness call (AI SDK 7: result.usage is already the
 * sum across all steps — not just the final step — so this is billable-accurate
 * without summing step callbacks ourselves).
 */
export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  steps: number;
};

export async function runModelHarness(
  input: RunModelInput,
): Promise<{
  text: string;
  cacheReadTokens: number | null;
  session: TraceSession;
  usage: HarnessUsage;
  /** Assistant + tool messages produced by this call, for continuing or persisting the run. */
  responseMessages: ModelMessage[];
  /** Tool names called in each step, oldest first. */
  stepToolNames: string[][];
}> {
  const credential = await keyFor(input.db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const traceId = randomUUID();
  const session =
    input.traceSession ??
    createTraceSession({
      traceId,
      runId: input.runId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      mode: input.mode,
      provider: input.provider,
      modelId: input.modelId,
      delegationId: input.delegationId,
    });

  const toolNames = Object.keys(input.tools).sort();
  await session.emit({
    type: "run.start",
    prefix: input.prefix,
    tail: input.tail,
    promptCacheKey: input.promptCacheKey,
    toolNames,
    instructions: prompt.instructions,
    modelMessages: prompt.messages,
  });

  let stepIndex = 0;
  // The chat agent's real limit is the closing rule in loop-control, which
  // can stretch for team setup; this is only the hard stop behind it.
  const maxSteps = input.maxSteps ?? (input.mode === "dispatcher" ? MAX_MODEL_STEPS_HARD : MAX_MODEL_STEPS_DISPATCHER);
  const restrictedNote = new Set<string>();
  try {
    const result = await generateText({
      model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools: input.tools,
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      ...(input.mode === "dispatcher" ? { maxOutputTokens: DISPATCHER_MAX_OUTPUT_TOKENS } : {}),
      stopWhen: [
        isStepCount(maxSteps),
        ({ steps }) =>
          Boolean(
            input.shouldStop?.(
              steps.map((step) => (step.toolCalls ?? []).map((call) => (call as { toolName?: string }).toolName ?? "")),
            ),
          ),
      ],
      // One free fix for inputs that are wrong in shape but clear in meaning,
      // so the slip does not cost a whole step.
      repairToolCall: async ({ toolCall }) => {
        const repaired = repairToolInput(toolCall.toolName, toolCall.input);
        return repaired ? { ...toolCall, input: repaired } : null;
      },
      prepareStep: ({ steps, messages }) => {
        const restriction = input.restrictStep?.(
          steps.length,
          maxSteps,
          steps.map((step) => (step.toolCalls ?? []).map((call) => (call as { toolName?: string }).toolName ?? "")),
        );
        if (!restriction) {
          const offered = input.activeTools?.();
          return offered ? { activeTools: offered.filter((name) => name in input.tools) as never } : undefined;
        }
        // A closing step never widens what the turn was offered.
        const offeredNow = input.activeTools?.();
        const activeTools = restriction.activeTools.filter(
          (name) => name in input.tools && (!offeredNow || offeredNow.includes(name)),
        );
        // The note is appended once per distinct text; the override carries forward.
        if (!restriction.note || restrictedNote.has(restriction.note)) return { activeTools: activeTools as never };
        restrictedNote.add(restriction.note);
        return {
          activeTools: activeTools as never,
          messages: [...messages, { role: "user" as const, content: restriction.note }],
        };
      },
      providerOptions: usesOfficialOpenAiEndpoint(input.provider, credential.baseUrl)
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
      onStepEnd: async (step) => {
        stepIndex += 1;
        const usage = step.usage
          ? {
              inputTokens: step.usage.inputTokens,
              outputTokens: step.usage.outputTokens,
              cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
              reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens,
            }
          : undefined;
        const toolCalls = (step.toolCalls ?? []).map((call) => {
          const toolCallId = (call as { toolCallId?: string }).toolCallId ?? randomUUID();
          const name = (call as { toolName?: string }).toolName ?? "unknown";
          const toolInput = (call as { input?: unknown }).input ?? (call as { args?: unknown }).args ?? null;
          return { toolCallId, name, input: toolInput };
        });
        const toolResults = (step.toolResults ?? []).map((r) => {
          const toolCallId = (r as { toolCallId?: string }).toolCallId ?? "";
          const name = (r as { toolName?: string }).toolName ?? "unknown";
          const raw = (r as { output?: unknown }).output ?? (r as { result?: unknown }).result ?? null;
          const output =
            raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)
              ? (raw as { value: unknown }).value
              : raw;
          return { toolCallId, name, outputPreview: tracePreview(output ?? "(no result yet)") };
        });
        await session.emit({
          type: "model.step.finish",
          step: stepIndex,
          text: (step.text ?? "").slice(0, 300),
          usage,
          toolCalls,
          toolResults,
        });
      },
    });

    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? undefined,
      reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
    };
    await session.emit({
      type: "run.finish",
      text: result.text,
      usage,
      steps: stepIndex,
    });

    const details = result.usage.inputTokenDetails as
      | { cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    const outDetails = result.usage.outputTokenDetails as { reasoningTokens?: number } | undefined;
    return {
      text: result.text,
      cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? null,
      session,
      responseMessages: result.responseMessages as ModelMessage[],
      stepToolNames: result.steps.map((step) =>
        (step.toolCalls ?? []).map((call) => (call as { toolName?: string }).toolName ?? ""),
      ),
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        cacheReadTokens: details?.cacheReadTokens ?? null,
        cacheWriteTokens: details?.cacheWriteTokens ?? null,
        reasoningTokens: outDetails?.reasoningTokens ?? null,
        steps: stepIndex,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model failed.";
    await session.emit({ type: "run.error", phase: "model", message });
    throw error;
  }
}
