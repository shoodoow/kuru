import type { MessageBlock } from "@kuru/shared";
/**
 * Room turn orchestration: run ledger, speaker queue, queue drain.
 * DB: runs, messages, events (via TurnEmitter).
 */
import { relayAwaitedReply, reportRoundToLead } from "./team-chat.js";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages } from "../db/schema.js";
import { speakers } from "../rooms/mentions.js";
import { claimQueuedForRoom, saveUserMessage } from "../rooms/rooms.js";
import { acquireRun, failRun, finishRun, heartbeatRun } from "../rooms/runs.js";
import { publish, type StreamEvent } from "../rooms/stream.js";
import { HEARTBEAT_MS } from "./constants.js";
import { TurnEmitter } from "./events/emitter.js";
import { registerWorkerLifecycle } from "./handlers/worker-lifecycle.js";
import { speakOnce } from "./speaker.js";
import { compactConversation } from "../memory/compact-turn.js";
import type { GenerateResult, TurnInput, TurnOptions } from "./types.js";
import { noted } from "../log/logger.js";

type Db = ReturnType<typeof getDb>;

let workerLifecycleReady = false;
/** Idempotent. Exported so boot can register it before any turn has run. */
export function ensureWorkerLifecycle(db: Db): void {
  if (workerLifecycleReady) return;
  workerLifecycleReady = true;
  registerWorkerLifecycle(() => db, runTurn);
}

/** Most agent turns in one round of a room, across all speakers. */
const MAX_SPEAKER_TURNS = 8;
/** Times per round the floor returns to the lead because a teammate named nobody. */
const MAX_LEAD_RETURNS = 3;

export async function runTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  body: string | { text: string; blocks?: MessageBlock[] | null; replyTo?: string | null },
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  options?: TurnOptions,
) {
  ensureWorkerLifecycle(db);
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) throw new Error("Room not found");

  const memberRows = await db
    .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
    .from(members)
    .innerJoin(agents, eq(members.agentId, agents.id))
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));

  const runId =
    options?.existingRunId ??
    (await acquireRun(db, accountId, conversationId, options?.kind ?? "turn", options?.acquireTimeoutMs)).id;
  await heartbeatRun(db, runId).catch(noted("Run heartbeat"));

  const emitter = new TurnEmitter(db, {
    accountId,
    conversationId,
    runId,
    onEvent: options?.onEvent,
  });
  const emit = (event: Parameters<TurnEmitter["emit"]>[0]) => emitter.emit(event);

  // Wall clock per bubble so a long turn does not back-date replies before
  // messages the person sent while the agent was still thinking.
  let stamp = 0;
  const nextTime = () => {
    const now = Date.now();
    stamp = stamp === 0 ? now : Math.max(stamp + 1, now);
    return new Date(stamp);
  };
  const incoming = typeof body === "string" ? { text: body, blocks: null as null, replyTo: null as null } : body;
  if (!options?.cue) {
    if (options?.alreadySavedUserMessage) {
      await db
        .update(messages)
        .set({ runId })
        .where(and(eq(messages.id, options.alreadySavedUserMessage.id), eq(messages.accountId, accountId)));
    } else {
      await saveUserMessage(db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId,
      });
    }
  }

  const beat = setInterval(() => {
    void heartbeatRun(db, runId).catch(noted("Run heartbeat"));
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  const saved: (typeof messages.$inferSelect)[] = [];
  // Billable usage for this run: every speaker adds its harness total.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, steps: 0 };
  try {
    const queue = options?.speakerId ? [options.speakerId] : speakers(incoming.text, memberRows, room.ownerAgentId);
    // Teammates hand work back and forth (write, review, revise), so an agent
    // may speak more than once. The cap is what ends a round, not "once each".
    let turnsTaken = 0;
    let ownerSpoke = false;
    let lastSpeaker = "";
    let leadReturns = 0;
    while (queue.length > 0 && turnsTaken < MAX_SPEAKER_TURNS) {
      const agentId = queue.shift();
      if (!agentId) continue;
      turnsTaken += 1;
      const spoken = new Set<string>([agentId]);
      if (agentId === room.ownerAgentId) ownerSpoke = true;
      lastSpeaker = agentId;
      await speakOnce(db, {
        accountId,
        conversationId,
        agentId,
        memberRows,
        room,
        skillsRoot,
        generate,
        nextTime,
        runId,
        emit,
        saved,
        queue,
        spoken,
        // The private note is for whoever was woken by it, not the whole chain.
        cue: turnsTaken === 1 ? options?.cue : undefined,
        runKind: options?.kind,
        usage,
      });
      await heartbeatRun(db, runId).catch(noted("Run heartbeat"));
      // A teammate who finishes without naming who is next leaves the work
      // sitting. The lead is the one driving, so the floor goes back to them.
      const leadDriving = ownerSpoke || (Boolean(options?.cue) && options?.kind !== "routine");
      if (
        leadReturns < MAX_LEAD_RETURNS &&
        queue.length === 0 &&
        room.kind === "group" &&
        room.ownerAgentId &&
        lastSpeaker !== room.ownerAgentId &&
        leadDriving &&
        turnsTaken < MAX_SPEAKER_TURNS
      ) {
        leadReturns += 1;
        queue.push(room.ownerAgentId);
      }
    }
    await compactConversation(db, accountId, conversationId);
    await finishRun(
      db,
      runId,
      usage.steps > 0
        ? {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            reasoningTokens: usage.reasoning,
            modelSteps: usage.steps,
          }
        : undefined,
    );
    await emit({ type: "run", run: { id: runId, status: "done" as const, error: null } });
    emitter.emitDone();
    // A round the team ran on its own (no person message started it) is
    // reported to the lead's private chat, where the person is listening.
    if (room.kind === "group" && options?.cue && room.ownerAgentId && !generate && saved.length > 0) {
      const lead = room.ownerAgentId;
      void reportRoundToLead(
        db,
        { accountId, groupId: conversationId, groupTitle: room.title, leadAgentId: lead, rows: saved, skillsRoot },
        (roomId, cue, speakerId) =>
          runTurn(db, accountId, roomId, cue, undefined, skillsRoot, {
            cue,
            speakerId,
            acquireTimeoutMs: 600_000,
            onEvent: (event) => publish(accountId, roomId, event),
          }),
      ).catch(noted("A queued follow-up turn"));
    }
    // An answer another agent is waiting for goes back to that agent's chat.
    if (room.kind === "direct" && room.ownerAgentId && !generate && saved.length > 0) {
      void relayAwaitedReply(
        db,
        { accountId, roomId: conversationId, ownerAgentId: room.ownerAgentId, rows: saved },
        (roomId, cue, speakerId) =>
          runTurn(db, accountId, roomId, cue, undefined, skillsRoot, {
            cue,
            speakerId,
            acquireTimeoutMs: 600_000,
            onEvent: (event) => publish(accountId, roomId, event),
          }),
      ).catch(noted("A queued follow-up turn"));
    }
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The turn failed.";
    await failRun(db, runId, message).catch(noted("Marking a run as failed"));
    await emit({ type: "error", error: message });
    throw error;
  } finally {
    clearInterval(beat);
    await continueQueuedTurn(db, accountId, conversationId, generate, skillsRoot, options?.onEvent).catch(noted("Continuing the queued turn"));
  }
}

export async function continueQueuedTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  onEvent?: (event: StreamEvent) => void,
): Promise<boolean> {
  const claimed = await claimQueuedForRoom(db, accountId, conversationId);
  const latest = claimed[claimed.length - 1];
  if (!latest) return false;
  let runId: string;
  try {
    runId = (await acquireRun(db, accountId, conversationId, "turn", 0)).id;
  } catch (error) {
    await db
      .update(messages)
      .set({ queued: true })
      .where(and(eq(messages.id, latest.id), eq(messages.accountId, accountId)))
      .catch(noted("Putting a message back in the queue"));
    if (error instanceof Error && /busy/.test(error.message)) return false;
    throw error;
  }
  await runTurn(db, accountId, conversationId, latest.body, generate, skillsRoot, {
    existingRunId: runId,
    alreadySavedUserMessage: { id: latest.id, text: latest.body },
    onEvent,
  });
  return true;
}
