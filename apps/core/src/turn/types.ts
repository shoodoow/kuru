/**
 * Shared turn-engine types.
 * Why: one import surface for orchestrator, speaker, agent loop, and tests.
 * DB: types only — no persistence here.
 */
import type { StreamEvent } from "../rooms/stream.js";
import type { TurnMessageContent } from "./prompt-media.js";
import type { WorkLogEntry } from "../db/schema.js";

export type { TurnImagePart, TurnMessageContent } from "./prompt-media.js";

export type TurnInput = {
  agentId: string;
  provider: string;
  modelId: string;
  system: string;
  prefix: string;
  tail: string;
  promptCacheKey: string;
  messages: { role: "user" | "assistant"; content: TurnMessageContent }[];
  accountId: string;
  linuxProfile: string | null;
};

export type TurnOptions = {
  onEvent?: (event: StreamEvent) => void;
  alreadySavedUserMessage?: { id: string; text: string };
  existingRunId?: string;
  kind?: "turn" | "routine";
  cue?: string;
  /** The cue may end with no message at all (a reaction): the agent decides whether it has anything to say. */
  quietOk?: boolean;
  speakerId?: string;
  acquireTimeoutMs?: number;
};

export type GenerateUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  steps?: number;
};

export type GenerateResult =
  | string
  | {
      text: string;
      cacheReadTokens?: number | null;
      usage?: GenerateUsage;
      /** Hidden wake that started background work: ending without a bubble is fine. */
      quiet?: boolean;
      /** Finished tool calls this turn, clipped, for the agent's work log. */
      workLog?: WorkLogEntry[];
      /** Plain text that follows work done after the last bubble: post it as well. */
      finalTextIsReply?: boolean;
      proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
    };

export type AgentMode = "dispatcher" | "worker" | "delegate";
