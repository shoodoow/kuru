/**
 * Subscribes to worker.settled on TurnBus — parent always gets delivery or wake.
 * DB: delegations.result already set by runWorker before emit; reads
 * delegations to see whether sibling workers are still running.
 */
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { delegations } from "../../db/schema.js";
import { subscribeTurnBus } from "../events/bus.js";
import { resumeParentAfterWorker } from "../parent-wake.js";
import { noted } from "../../log/logger.js";
import { prompt } from "../../prompt/prompts.js";
import { publish } from "../../rooms/stream.js";

type Db = ReturnType<typeof getDb>;

/** Quiet gap after a result before the parent is woken, so near-simultaneous results share one wake. */
const SETTLE_DEBOUNCE_MS = 1_500;

/**
 * Longest a finished result waits for sibling workers that are still running.
 * Why: each wake is a full dispatcher turn and usually a bubble; three workers
 * finishing seconds apart used to produce three near-identical messages.
 */
const MAX_HOLD_MS = 90_000;

let registered = false;

type SettledEvent = {
  workerId: string;
  task: string;
  result: string;
  delegationId: string;
  status: "done" | "failed";
};

interface PendingWake {
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
  accountId: string;
  conversationId: string;
  parentAgentId: string;
  skillsRoot?: string;
  events: SettledEvent[];
}

const pendingWakes = new Map<string, PendingWake>();

async function siblingsStillRunning(db: Db, pending: PendingWake): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, pending.accountId),
        eq(delegations.conversationId, pending.conversationId),
        eq(delegations.parentAgentId, pending.parentAgentId),
        eq(delegations.status, "running"),
      ),
    );
  return (row?.count ?? 0) > 0;
}

function arm(key: string, pending: PendingWake, delayMs: number, flush: (key: string) => void): void {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => flush(key), delayMs);
  (pending.timer as unknown as { unref?: () => void }).unref?.();
}

export function registerWorkerLifecycle(
  getDbInstance: () => Db,
  runTurn: Parameters<typeof resumeParentAfterWorker>[2],
): void {
  if (registered) return;
  registered = true;

  const flush = (key: string): void => {
    const pending = pendingWakes.get(key);
    if (!pending) return;
    const db = getDbInstance();
    void (async () => {
      const heldMs = Date.now() - pending.firstAt;
      const waiting = heldMs < MAX_HOLD_MS && (await siblingsStillRunning(db, pending).catch(() => false));
      if (pendingWakes.get(key) !== pending) return;
      if (waiting) {
        // A sibling settling re-arms the short debounce; this is only the ceiling.
        arm(key, pending, MAX_HOLD_MS - heldMs, flush);
        return;
      }
      pendingWakes.delete(key);
      await resumeParentAfterWorker(
        db,
        {
          accountId: pending.accountId,
          conversationId: pending.conversationId,
          parentAgentId: pending.parentAgentId,
          skillsRoot: pending.skillsRoot,
          settled: pending.events.length === 1 ? pending.events[0]! : pending.events,
        },
        runTurn,
      );
    })().catch(noted("Starting the turn that reports finished workers"));
  };

  // A worker's question: the agent is woken to answer it. Nothing is batched, the worker is waiting.
  subscribeTurnBus(async (event) => {
    if (event.type !== "worker.asks") return;
    const options = event.options?.length
      ? prompt("cues", "worker-asks-options", { list: event.options.map((option) => `"${option}"`).join(", "), pick: event.pick?.trim() ? `"${event.pick.trim()}"` : "none stated" })
      : event.pick?.trim()
        ? `It would go with: "${event.pick.trim()}".`
        : "";
    const cue = prompt("cues", "worker-asks", { workerId: event.workerId, task: event.task.slice(0, 200), question: event.question, options });
    await runTurn(getDbInstance(), event.accountId, event.conversationId, cue, undefined, event.skillsRoot, {
      cue,
      speakerId: event.parentAgentId,
      acquireTimeoutMs: 120_000,
      onEvent: (streamed) => publish(event.accountId, event.conversationId, streamed),
    }).catch(noted("Starting the turn that answers a worker's question"));
  });

  subscribeTurnBus(async (event) => {
    if (event.type !== "worker.settled") return;
    // Every result goes privately through the parent. Hidden workers never
    // publish in the parent's voice; the parent reviews, summarizes, attaches
    // artifacts, retries, or stays quiet. Results are batched per parent+room.
    const key = `${event.conversationId}:${event.parentAgentId}`;
    const settled: SettledEvent = {
      workerId: event.workerId,
      task: event.task,
      result: event.result,
      delegationId: event.delegationId,
      status: event.status,
    };
    const existing = pendingWakes.get(key);
    if (existing) {
      existing.events.push(settled);
      arm(key, existing, SETTLE_DEBOUNCE_MS, flush);
      return;
    }
    const pending: PendingWake = {
      // A placeholder so the field is always a timer; arm() replaces it below.
      timer: setTimeout(() => undefined, 0),
      firstAt: Date.now(),
      accountId: event.accountId,
      conversationId: event.conversationId,
      parentAgentId: event.parentAgentId,
      skillsRoot: event.skillsRoot,
      events: [settled],
    };
    pendingWakes.set(key, pending);
    arm(key, pending, SETTLE_DEBOUNCE_MS, flush);
  });
}
