import { TAIL_MESSAGE_CHARS } from "./constants.js";
import type { GenerateResult, GenerateUsage } from "./types.js";
import type { WorkLogEntry } from "../db/schema.js";

/** Shortens one message for the prompt tail. DB row and recall query keep the full text. */
export function tailSlice(body: string): string {
  if (body.length <= TAIL_MESSAGE_CHARS) return body;
  return `${body.slice(0, TAIL_MESSAGE_CHARS)}…`;
}

/** Longest a person's own message may run in the prompt; far beyond any real message. */
export const PERSON_MESSAGE_CHARS = 30_000;

/**
 * A message as the agent reads it: the person's words whole, an agent's shortened.
 * Why: every message was cut at 2,000 characters, so a 4,900-character video
 * brief reached the agent as its first half, and the scenes and specs in the
 * second half were never built. What the person writes is the job; what an
 * agent wrote is its own and stays searchable in full.
 */
export function historyBody(body: string, fromPerson: boolean): string {
  if (!fromPerson) return tailSlice(body);
  return body.length <= PERSON_MESSAGE_CHARS ? body : `${body.slice(0, PERSON_MESSAGE_CHARS)}…`;
}

export function unwrapGenerateResult(result: GenerateResult): {
  text: string;
  cacheReadTokens: number | null;
  usage?: GenerateUsage;
  quiet?: boolean;
  workLog?: WorkLogEntry[];
  finalTextIsReply?: boolean;
  proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
} {
  if (typeof result === "string") {
    return { text: result, cacheReadTokens: null };
  }
  return { text: result.text, cacheReadTokens: result.cacheReadTokens ?? null, usage: result.usage, quiet: result.quiet, workLog: result.workLog, finalTextIsReply: result.finalTextIsReply, proposal: result.proposal };
}