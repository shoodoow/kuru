import { and, eq, lt } from "drizzle-orm";
import type { getDb, Store } from "../db/client.js";
import { runs } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;

export const RUN_POLL_MS = 200;
export const RUN_ACQUIRE_TIMEOUT_MS = 120_000;
export const RUN_STALE_MS = 120_000;

/** Thrown when a room already has a turn running and the caller would not wait. */
export class RoomBusyError extends Error {
  constructor() {
    super("The room is busy with another turn. Try again shortly.");
    this.name = "RoomBusyError";
  }
}

/**
 * Finds the running run on one room, if any.
 * Why: room serialization moved off the row lock onto the ledger — every
 * waiter and the scheduler reads this single row to decide.
 * Input: store, account id, conversation id. Output: the running run or undefined.
 */
export async function findRunningRun(store: Store, accountId: string, conversationId: string) {
  const [row] = await store
    .select()
    .from(runs)
    .where(and(eq(runs.accountId, accountId), eq(runs.conversationId, conversationId), eq(runs.status, "running")));
  return row;
}

/**
 * Claims the turn slot on one room, waiting for any running run to land.
 * Why: two turns on one room must never interleave (mention chaining reads
 * fresh history per speaker). Poll-wait preserves the old lock-queue behavior
 * without holding a Postgres transaction open for the whole turn.
 * Input: db, account/conversation ids, kind, timeout/poll overrides.
 * Output: the claimed running run. Throws RoomBusyError past the timeout.
 */
export async function acquireRun(
  db: Db,
  accountId: string,
  conversationId: string,
  kind: "turn" | "routine" = "turn",
  timeoutMs = RUN_ACQUIRE_TIMEOUT_MS,
  pollMs = RUN_POLL_MS,
) {
  const started = Date.now();
  for (;;) {
    try {
      const [row] = await db
        .insert(runs)
        .values({ accountId, conversationId, kind, status: "running" })
        .returning();
      if (!row) throw new Error("Run insert returned no row.");
      return row;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (Date.now() - started > timeoutMs) {
        throw new RoomBusyError();
      }
      await sleep(pollMs);
    }
  }
}

/**
 * Advances a run's heartbeat so crash recovery can tell live from dead.
 * Why: a running run with a fresh heartbeat is working; one stale past
 * RUN_STALE_MS is a crash the scheduler must reclaim. Called at speaker
 * boundaries and on a timer during long model calls.
 * Input: store, run id. Output: nothing.
 */
export async function heartbeatRun(store: Store, runId: string): Promise<void> {
  await store.update(runs).set({ heartbeatAt: new Date() }).where(eq(runs.id, runId));
}

/**
 * Lands a run as done.
 * Why: terminal state unblocks the room (partial unique index releases) and
 * tells SSE watchers + push policy the thread settled.
 * Input: store, run id. Output: nothing.
 */
export type RunUsage = {
  /** The model the turn ran on, for usage by model. */
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  modelSteps?: number;
};

export async function finishRun(store: Store, runId: string, usage?: RunUsage): Promise<void> {
  await store
    .update(runs)
    .set({
      status: "done",
      heartbeatAt: new Date(),
      ...(usage?.provider && usage.modelId ? { provider: usage.provider, modelId: usage.modelId } : {}),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.cacheReadTokens !== undefined && usage.cacheReadTokens !== null
        ? { cacheReadTokens: usage.cacheReadTokens }
        : {}),
      ...(usage?.cacheWriteTokens !== undefined && usage.cacheWriteTokens !== null
        ? { cacheWriteTokens: usage.cacheWriteTokens }
        : {}),
      ...(usage?.reasoningTokens !== undefined && usage.reasoningTokens !== null
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
      ...(usage?.modelSteps !== undefined ? { modelSteps: usage.modelSteps } : {}),
    })
    .where(eq(runs.id, runId));
}

/**
 * Lands a run as failed with the reason.
 * Why: failures must be as visible as completions — the room unblocks, the
 * client gets an error event, and the push relay can ping on action-needed.
 * Input: store, run id, error text. Output: nothing.
 */
export async function failRun(store: Store, runId: string, error: string): Promise<void> {
  await store
    .update(runs)
    .set({ status: "failed", error: error.slice(0, 2000), heartbeatAt: new Date() })
    .where(eq(runs.id, runId));
}

/**
 * Reclaims runs whose heartbeat went stale (crashed core or hung model).
 * Why: without this a kill -9 wedges the room forever under the one-running
 * unique index. Reclaim marks failed so waiters proceed and clients resolve.
 * Input: store, staleness threshold ms. Output: the reclaimed rows.
 */
export async function reclaimStaleRuns(store: Store, staleMs = RUN_STALE_MS) {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await store
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.heartbeatAt, cutoff)));
  for (const row of stale) {
    await failRun(store, row.id, "The turn stopped without finishing (core restarted or hung) and was reclaimed.");
  }
  return stale;
}

/**
 * Detects a partial-unique-index collision across drivers.
 * Why: postgres-js/drizzle wrap the PostgresError as `cause` on a "Failed
 * query" Error, so the 23505 code lives one level down. Keep the check narrow
 * so real errors still throw. Pure for testing via injected objects.
 * Input: unknown error. Output: true when it is a unique violation.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
