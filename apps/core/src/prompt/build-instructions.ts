import { readFileSync } from "node:fs";
import { aboutShort, aboutWorkAgent } from "./capabilities.js";
import { prompt } from "./prompts.js";

/**
 * One agent's composed identity (Phase 17).
 * Why: three labeled fields compose in fixed order so the cached prefix is
 * stable. `name` grounds the @mention mesh; `role` is the job title;
 * `personality` is tone only; `job` carries the standing duties.
 */
export type AgentIdentity = {
  name: string;
  role: string;
  personality: string;
  job: string;
  /** Picks the standing prompt. Left out, the agent is a work agent. */
  kind?: string | null;
};

/** Kinds with their own prompt file; its `# prompt` section is the standing prompt. */
const kindPromptFiles = new Set(["companion", "support"]);

/**
 * Reads the standing prompt for one agent kind.
 * Why: an agent kept for conversation, or the default agent that sets the
 * others up, must not be told it has workers and a computer.
 * Input: the agent's kind. Output: the prompt text, read fresh so an edit applies on the next turn.
 */
export function standingPrompt(kind?: string | null): string {
  if (kind && kindPromptFiles.has(kind)) return prompt(kind, "prompt");
  return readFileSync(new URL("../../../../prompts/system.md", import.meta.url), "utf8").trim();
}

/**
 * Composes one agent's identity block in fixed order.
 * Why: fixed join keeps prefix bytes stable for provider caching — conditional
 * reordering would miss cache every turn. Empty personality omits its line.
 * Input: name/role/personality/job. Output: the identity block text.
 */
export function buildAgentIdentity(input: AgentIdentity): string {
  const head = `You are ${input.name} — ${input.role}.`;
  const tone = input.personality.trim()
    ? `Personality: ${input.personality.trim()}\n(This is your voice. Keep it consistent; do not drift into a generic assistant.)`
    : null;
  return [head, ...(tone ? [tone] : []), `Job:\n${input.job}`].join("\n\n");
}

/**
 * Builds the cacheable standing prompt for one turn.
 * Why: the system prompt plus the composed identity is the cache-stable
 * prefix — room/summary/messages always live after the breakpoint in the tail.
 * Input: an AgentIdentity.
 * Output: the standing system prompt, what the agent is and can do, then that identity block.
 */
export function buildInstructions(identity: AgentIdentity): string {
  // Who the agent is in the product, and what it can do, sit between its method and its identity.
  const about = identity.kind && kindPromptFiles.has(identity.kind) ? aboutShort() : aboutWorkAgent();
  return [standingPrompt(identity.kind), about, buildAgentIdentity(identity)].join("\n\n");
}
