/**
 * Single AI SDK entry: generateText + trace events.
 * Why: every dispatcher/worker/delegate model call is inspectable via TracePlugin.
 * DB: none (tools write via registry).
 */
import { repairToolInput } from "../tools/repair-input.js";
import { generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";
import { getModel } from "../../model/get-model.js";
import { openAiCacheOptions, stepMessages } from "../../model/cache-hints.js";
import { keyFor } from "../../keys/keys.js";
import type { getDb } from "../../db/client.js";
import { toModelPrompt } from "../prompt-model.js";
import { picturesAsNotes } from "../prompt-media.js";
import { isNoImageInputError, learnCapability, modelCapabilities } from "../../model/capabilities.js";
import { isOutOfCreditError, noteCreditOutage } from "../../model/credit.js";
import type { TurnInput } from "../types.js";
import { DISPATCHER_MAX_OUTPUT_TOKENS, MAX_MODEL_STEPS_DISPATCHER, MAX_MODEL_STEPS_HARD } from "../constants.js";
import { createTraceSession, type TraceSession } from "./plugins.js";
import { tracePreview } from "./sinks/jsonl.js";
import type { AgentMode } from "../types.js";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof getDb>;

export type RunModelInput = TurnInput & {
  /**
   * Called with the text the model wrote in a response that also calls tools,
   * after the response is parsed and before any tool runs. The chat agent
   * posts it at once, so the person hears back before the work, not after it.
   */
  onLeadIn?: (text: string) => Promise<void>;
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
  // A model known to read only text never gets the pictures in the chat.
  const canSee = (await modelCapabilities(input.provider, input.modelId).catch(() => ({ vision: null }))).vision !== false;
  if (!canSee) input = { ...input, messages: picturesAsNotes(input.messages as unknown[]) as never };
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
        let activeTools: string[] | undefined;
        let sent = messages;
        if (!restriction) {
          activeTools = input.activeTools?.()?.filter((name) => name in input.tools);
        } else {
          // A closing step never widens what the turn was offered.
          const offeredNow = input.activeTools?.();
          activeTools = restriction.activeTools.filter(
            (name) => name in input.tools && (!offeredNow || offeredNow.includes(name)),
          );
          // The note is appended once per distinct text; the override carries forward.
          if (restriction.note && !restrictedNote.has(restriction.note)) {
            restrictedNote.add(restriction.note);
            sent = [...messages, { role: "user" as const, content: restriction.note }];
          }
        }
        // Anthropic: mark the newest message so the next step reads this one from cache.
        // Without it every chat step paid full price for the tail and the turn's tool results.
        sent = stepMessages(input.provider, sent);
        return {
          ...(activeTools ? { activeTools: activeTools as never } : {}),
          ...(sent !== messages ? { messages: sent } : {}),
        };
      },
      providerOptions: openAiCacheOptions(input.provider, credential.baseUrl, input.promptCacheKey),
      onLanguageModelCallEnd: input.onLeadIn
        ? async (call) => {
            const parts = call.content as ReadonlyArray<{ type: string; text?: string }>;
            if (!parts.some((part) => part.type === "tool-call")) return;
            const text = parts
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("")
              .trim();
            if (text) await input.onLeadIn?.(text).catch(() => undefined);
          }
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
    // The provider says this model takes no pictures: remember that and answer again without them.
    if (canSee && isNoImageInputError(error)) {
      learnCapability(input.provider, input.modelId, { vision: false });
      return runModelHarness(input);
    }
    // No credit: background jobs of this account stop starting until it is back.
    if (isOutOfCreditError(error)) noteCreditOutage(input.accountId, input.provider);
    const message = error instanceof Error ? error.message : "Model failed.";
    await session.emit({ type: "run.error", phase: "model", message });
    throw error;
  }
}
