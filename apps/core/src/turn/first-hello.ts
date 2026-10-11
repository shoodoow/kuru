/**
 * A new agent's first message, written by the agent itself.
 * Why: a new chat used to open empty and ask the person to say hi to an agent
 * that already knew why it was hired. The agent opens instead: who it is,
 * what it is here for, and a first step. Wording: prompts/cues.md.
 * DB: reads messages; the turn it starts writes like any other turn.
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { messages } from "../db/schema.js";
import { noted } from "../log/logger.js";
import { prompt } from "../prompt/prompts.js";
import type { GenerateResult, TurnInput } from "./types.js";

type Db = ReturnType<typeof getDb>;

/** The private note that tells an agent of this kind to open its chat. */
export function firstHelloCue(kind: string, unset = false): string {
  if (unset) return prompt("cues", "new-agent-first-hello");
  if (kind === "support") return prompt("cues", "support-first-hello");
  if (kind === "companion") return prompt("cues", "companion-first-hello");
  return prompt("cues", "agent-first-hello");
}

/**
 * Starts the agent's opening turn in the background, if its chat is still empty.
 * Input: db, the account, the agent's private chat, the agent and its kind,
 * plus the model stub and skills folder when the caller has them.
 * Output: nothing; a failure is logged and the chat simply stays empty.
 */
export function startFirstHello(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    kind: string;
    /** Created with only a name: it opens by asking what the person wants from it. */
    unset?: boolean;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
    skillsRoot?: string;
  },
): void {
  void (async () => {
    const [any] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, input.accountId), eq(messages.conversationId, input.conversationId)))
      .limit(1);
    if (any) return;
    const [{ runTurn }, { publish }] = await Promise.all([import("./orchestrator.js"), import("../rooms/stream.js")]);
    const cue = firstHelloCue(input.kind, input.unset);
    await runTurn(db, input.accountId, input.conversationId, cue, input.generate, input.skillsRoot, {
      cue,
      speakerId: input.agentId,
      acquireTimeoutMs: 60_000,
      onEvent: (event) => publish(input.accountId, input.conversationId, event),
    });
  })().catch(noted("A new agent's first message"));
}
