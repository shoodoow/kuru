import { routineSchema } from "@kuru/shared";
import { prompt } from "../prompt/prompts.js";
import { routineCreateInputSchema, routineIdSchema, routineUpdateInputSchema } from "@kuru/agent-tools";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import type { Store } from "../db/client.js";
import { jobs, routines } from "../db/schema.js";
import { acquireRun, RoomBusyError } from "../rooms/runs.js";
import { publish } from "../rooms/stream.js";
import { runTurn, type GenerateResult, type TurnInput } from "../rooms/turn.js";
import type { StreamEvent } from "../rooms/stream.js";
import { nextCronRun } from "./cron.js";
import { startRoutineWorker } from "./routine-worker.js";
import { budgetState, warnAboutBudget } from "../turn/usage/budget.js";
import { creditOutage } from "../model/credit.js";
import { noted } from "../log/logger.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select" | "update" | "transaction">;

/**
 * Stores one schedule for an agent and the first job that will run it.
 * Input: database, account id, and the agent, room, title, instructions, cron, and optional first run time.
 * Output: the saved routine and its pending job.
 */
export async function createRoutine(db: Database, accountId: string, input: unknown) {
  const data = routineSchema.parse(input);
  const runAt = data.nextRunAt ? new Date(data.nextRunAt) : new Date();
  return db.transaction(async (tx) => {
    const [routine] = await tx
      .insert(routines)
      .values({
        accountId,
        agentId: data.agentId,
        conversationId: data.conversationId,
        title: data.title,
        instructions: data.instructions,
        cron: data.cron,
        nextRunAt: runAt,
      })
      .returning();
    if (!routine) {
      throw new Error("The routine insert returned no row.");
    }
    const [job] = await tx
      .insert(jobs)
      .values({ accountId, routineId: routine.id, status: "pending", runAt })
      .returning();
    if (!job) {
      throw new Error("The job insert returned no row.");
    }
    return { routine, job };
  });
}

/**
 * Claims one due job so a second worker cannot take it.
 * Why: paused routines never fire — claiming joins routines and skips them.
 * Input: a database client.
 * Output: the job marked running, or null when nothing is due.
 */
export async function claimDue(db: Database) {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(routines, eq(jobs.routineId, routines.id))
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date()), eq(routines.paused, false)))
      .orderBy(asc(jobs.runAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) {
      return null;
    }
    const [claimed] = await tx.update(jobs).set({ status: "running" }).where(eq(jobs.id, due.job.id)).returning();
    return claimed ?? null;
  });
}

/**
 * Lists due pending jobs oldest-first without claiming.
 * Why: the scheduler filters (tests scope to their routine; future shards by
 * tenant) BEFORE claiming, so ticks never steal each other's work. Bounded.
 * Paused routines are excluded here, not at claim time.
 * Input: db, limit. Output: due pending jobs.
 */
export async function listDueJobs(db: Database, limit = 20) {
  const rows = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(routines, eq(jobs.routineId, routines.id))
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date()), eq(routines.paused, false)))
    .orderBy(asc(jobs.runAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => row.job);
}

/**
 * Claims one specific job only if still pending (single atomic statement).
 * Why: claim-then-filter would wedge foreign jobs as running; claim-by-id
 * after filtering keeps unclaimed jobs claimable by their rightful worker.
 * Input: db, job id. Output: the running job, or null when already taken.
 */
export async function claimJob(db: Database, jobId: string) {
  const [claimed] = await db
    .update(jobs)
    .set({ status: "running" })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
    .returning();
  return claimed ?? null;
}

/**
 * Runs one due routine through the room turn.
 * Why: routines share the exact turn path as human messages (same prompt,
 * for audits and push copy. A busy room defers the job 30s instead of piling
 * on; any other failure marks the job failed but still reschedules, so one
 * bad run never kills the routine.
 * Input: db + optional generate stub / onEvent fanout / skillsRoot.
 * Output: saved replies, or null when no job is due or the room is busy.
 */
export async function runDue(
  db: ReturnType<typeof getDb>,
  generateOrOpts?: ((input: TurnInput) => Promise<string>) | {
    generate?: (input: TurnInput) => Promise<GenerateResult>;
    onEvent?: (event: StreamEvent) => void;
    skillsRoot?: string;
    // Why: the scheduler has no room watchers of its own — live fanout for
    // routine runs is published here where account+room are known, using the
    // same shape as user turns so clients cannot tell them apart.
    publish?: boolean;
    // Why: list-then-claim lets callers scope to their jobs (tests isolate by
    // routine; future shards by tenant) without wedging foreign jobs running.
    filterJob?: (job: { id: string; routineId: string; accountId: string }) => boolean;
  },
) {
  const opts = typeof generateOrOpts === "function" ? { generate: generateOrOpts } : (generateOrOpts ?? {});
  // List-then-claim (not blind claimDue) so the filter never wedges foreign
  // jobs: skipped jobs stay pending for their rightful worker.
  const due = await listDueJobs(db, 20);
  let job: (typeof due)[number] | null = null;
  for (const candidate of due) {
    if (opts.filterJob && !opts.filterJob(candidate)) continue;
    const claimed = await claimJob(db, candidate.id);
    if (claimed) {
      job = claimed;
      break;
    }
  }
  if (!job) {
    return null;
  }
  const [routine] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, job.routineId), eq(routines.accountId, job.accountId)));
  if (!routine) {
    throw new Error("Routine not found.");
  }
  const reschedule = async () => {
    const upcoming = nextRun(routine.cron, routine.timezone);
    await db.update(routines).set({ nextRunAt: upcoming }).where(eq(routines.id, routine.id));
    await db.insert(jobs).values({
      accountId: routine.accountId,
      routineId: routine.id,
      status: "pending",
      runAt: upcoming,
    });
  };
  // Over the day's spending limit, or out of provider credit: this run is
  // skipped, not queued, so a backlog does not all fire at once afterwards.
  const budget = await budgetState(db, routine.accountId).catch(() => null);
  const skipped = budget?.reached
    ? `Skipped: the account's daily spending limit ($${(budget.limitUsd ?? 0).toFixed(2)}) was reached.`
    : creditOutage(routine.accountId)
      ? "Skipped: the model provider has no credit left on this account."
      : null;
  if (skipped) {
    if (budget?.reached) await warnAboutBudget(db, routine.accountId, routine.conversationId, budget).catch(noted("Warning about the daily limit"));
    await db.update(jobs).set({ status: "failed", result: skipped }).where(eq(jobs.id, job.id));
    await db.update(routines).set({ lastRunAt: new Date(), lastRunStatus: "failed" }).where(eq(routines.id, routine.id));
    await reschedule();
    return [];
  }
  // A worker routine starts its worker and returns: no chat turn, and the
  // room stays free. The worker's report settles the job when it finishes.
  if (routine.runsAs === "worker") {
    try {
      const started = await startRoutineWorker(db, routine, job, { skillsRoot: opts.skillsRoot });
      if (!started) {
        await db.update(jobs).set({ status: "pending", runAt: new Date(Date.now() + 5 * 60_000) }).where(eq(jobs.id, job.id));
        return [];
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Routine failed.";
      await db.update(jobs).set({ status: "failed", result: failure.slice(0, 4000) }).where(eq(jobs.id, job.id));
      await db.update(routines).set({ lastRunAt: new Date(), lastRunStatus: "failed" }).where(eq(routines.id, routine.id));
    }
    await reschedule();
    return [];
  }
  let runId: string | null = null;
  try {
    try {
      // Fail-fast claim: a busy room defers (job back to pending, retry soon)
      // instead of blocking the whole scheduler tick for minutes.
      runId = (await acquireRun(db, routine.accountId, routine.conversationId, "routine", 0)).id;
    } catch (error) {
      if (error instanceof RoomBusyError) {
        await db.update(jobs).set({ status: "pending", runAt: new Date(Date.now() + 30_000) }).where(eq(jobs.id, job.id));
        return null;
      }
      throw error;
    }
    // Hidden cue wake — never save routine.instructions as a user bubble. The owning
    // agent runs the standing order and send_messages only when the person
    // should see something (check-in question, email digest, etc.).
    const [previous] = await db
      .select({ status: jobs.status, result: jobs.result, runAt: jobs.runAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.accountId, routine.accountId),
          eq(jobs.routineId, routine.id),
          inArray(jobs.status, ["done", "failed"]),
        ),
      )
      .orderBy(desc(jobs.runAt))
      .limit(1);
    const continuity = previous
      ? `\n${prompt("cues", "routine-previous-run", {
          runAt: previous.runAt.toISOString(),
          status: previous.status,
          result: previous.result?.slice(0, 1200) || "No visible outcome was recorded.",
        })}\n`
      : "";
    const cue = prompt("cues", "routine-wake", {
      title: routine.title,
      instructions: routine.instructions,
      continuity,
    });
    const replies = await runTurn(db, routine.accountId, routine.conversationId, cue, opts.generate, opts.skillsRoot, {
      existingRunId: runId,
      kind: "routine",
      cue,
      speakerId: routine.agentId,
      onEvent: (event) => {
        if (opts.publish) publish(routine.accountId, routine.conversationId, event);
        opts.onEvent?.(event);
      },
    });
    const outcome =
      replies
        .map((reply) => reply.body.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000) || "Completed with no user-facing message.";
    await db.update(jobs).set({ status: "done", result: outcome }).where(eq(jobs.id, job.id));
    await db
      .update(routines)
      .set({ lastRunAt: new Date(), lastRunStatus: "done" })
      .where(eq(routines.id, routine.id));
    await reschedule();
    return replies;
  } catch (error) {
    const failure = error instanceof Error ? error.message : "Routine failed.";
    await db.update(jobs).set({ status: "failed", result: failure.slice(0, 4000) }).where(eq(jobs.id, job.id));
    await db
      .update(routines)
      .set({ lastRunAt: new Date(), lastRunStatus: "failed" })
      .where(eq(routines.id, routine.id));
    await reschedule();
    throw error;
  }
}

/**
 * Computes the next fire time for a cron expression in its timezone.
 * Why: thin wrapper so routine code never hand-rolls date math — daily
 * "09:00 Europe/Berlin" survives DST via the shared parser. Pure.
 * Input: cron text + IANA timezone. Output: the next run Date.
 */
export function nextRun(cron: string, timezone = "UTC"): Date {
  return nextCronRun(cron, timezone);
}

/**
 * Creates a routine owned by the calling agent.
 * Why: owner-scoped self-automation — "remind me daily at 9" works without
 * human console steps, and one agent can never schedule work as another.
 * The first job fires at the next cron occurrence (not immediately), so
 * "every day at 09:00" means 09:00, not now.
 * Input: store, account/room/caller ids, {title, instructions, cron, timezone?, paused?}.
 * Output: the saved routine. Throws on bad cron/timezone.
 */
export async function createOwnRoutine(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    title: string;
    instructions: string;
    cron: string;
    timezone?: string;
    paused?: boolean;
    runAs?: "worker" | "agent";
    kind?: string;
    skills?: string[];
    briefFile?: string;
  },
) {
  const data = routineCreateInputSchema.parse({
    title: input.title,
    instructions: input.instructions,
    cron: input.cron,
    timezone: input.timezone ?? "UTC",
    paused: input.paused ?? false,
    runAs: input.runAs,
    kind: input.kind,
    skills: input.skills,
    briefFile: input.briefFile,
  });
  const runAt = nextCronRun(data.cron, data.timezone);
  const [routine] = await store
    .insert(routines)
    .values({
      accountId: input.accountId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      title: data.title,
      instructions: data.instructions,
      cron: data.cron,
      timezone: data.timezone,
      paused: data.paused,
      nextRunAt: runAt,
      runsAs: data.runAs ?? "agent",
      workerKind: data.kind ?? null,
      workerSkills: data.skills ?? [],
      briefPath: data.briefFile ?? null,
    })
    .returning();
  if (!routine) throw new Error("The routine insert returned no row.");
  if (!data.paused) {
    await store.insert(jobs).values({ accountId: input.accountId, routineId: routine.id, status: "pending", runAt });
  }
  return routine;
}

const RECENT_RUNS_LIMIT = 10;

/**
 * Lists the calling agent's own routines, each with up to 10 recent finished fires.
 * Why: the model needs ids to update/delete; the phone shows run history
 * (completed/failed) without a second round-trip per routine.
 * Input: store, account + caller ids. Output: own routines, soonest first.
 */
export async function listOwnRoutines(store: Store, accountId: string, agentId: string) {
  const rows = await store
    .select({
      id: routines.id,
      title: routines.title,
      instructions: routines.instructions,
      cron: routines.cron,
      timezone: routines.timezone,
      paused: routines.paused,
      nextRunAt: routines.nextRunAt,
      lastRunAt: routines.lastRunAt,
      lastRunStatus: routines.lastRunStatus,
      conversationId: routines.conversationId,
    })
    .from(routines)
    .where(and(eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .orderBy(asc(routines.nextRunAt));
  if (rows.length === 0) return [];
  const recentByRoutine = await recentRunsByRoutine(
    store,
    accountId,
    rows.map((row) => row.id),
    RECENT_RUNS_LIMIT,
  );
  return rows.map((row) => ({
    ...row,
    recentRuns: recentByRoutine.get(row.id) ?? [],
  }));
}

/**
 * Loads up to `limit` finished jobs per routine (newest first).
 * Why: jobs keep done/failed history; pending/running are not "last runs".
 */
export async function listOwnRoutineRuns(
  store: Store,
  accountId: string,
  agentId: string,
  routineId: string,
  limit = RECENT_RUNS_LIMIT,
) {
  const [owned] = await store
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  if (!owned) return null;
  const map = await recentRunsByRoutine(store, accountId, [routineId], limit);
  return map.get(routineId) ?? [];
}

async function recentRunsByRoutine(
  store: Store,
  accountId: string,
  routineIds: string[],
  limit: number,
): Promise<Map<string, { id: string; status: string; runAt: Date; result: string | null }[]>> {
  const out = new Map<string, { id: string; status: string; runAt: Date; result: string | null }[]>();
  if (routineIds.length === 0) return out;
  const runRows = await store
    .select({
      id: jobs.id,
      routineId: jobs.routineId,
      status: jobs.status,
      runAt: jobs.runAt,
      result: jobs.result,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.accountId, accountId),
        inArray(jobs.routineId, routineIds),
        inArray(jobs.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(jobs.runAt));
  for (const run of runRows) {
    const list = out.get(run.routineId) ?? [];
    if (list.length >= limit) continue;
    list.push({ id: run.id, status: run.status, runAt: run.runAt, result: run.result });
    out.set(run.routineId, list);
  }
  return out;
}

/**
 * Updates the calling agent's own routine.
 * Why: ownership enforced in the WHERE clause — the update touches zero rows
 * for foreign ids, which reads as "not found" instead of leaking existence.
 * Reschedules the pending job when cron/timezone changes (paused flips stop
 * or restart firing accordingly).
 * Input: store, account/caller ids, {routineId, title?, instructions?, cron?, timezone?, paused?}.
 * Output: the updated routine, or null when not owned.
 */
export async function updateOwnRoutine(
  store: Store,
  accountId: string,
  agentId: string,
  input: {
    routineId: string;
    title?: string;
    instructions?: string;
    cron?: string;
    timezone?: string;
    paused?: boolean;
    runAs?: "worker" | "agent";
    kind?: string;
    skills?: string[];
    briefFile?: string;
  },
) {
  const data = routineUpdateInputSchema.parse(input);
  const [owned] = await store
    .select()
    .from(routines)
    .where(and(eq(routines.id, data.routineId), eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  if (!owned) return null;
  const patch: Partial<{
    title: string;
    instructions: string;
    cron: string;
    timezone: string;
    paused: boolean;
    nextRunAt: Date;
    runsAs: string;
    workerKind: string | null;
    workerSkills: string[];
    briefPath: string | null;
  }> = {};
  if (data.runAs !== undefined) patch.runsAs = data.runAs;
  if (data.kind !== undefined) patch.workerKind = data.kind;
  if (data.skills !== undefined) patch.workerSkills = data.skills;
  if (data.briefFile !== undefined) patch.briefPath = data.briefFile || null;
  if (data.title !== undefined) patch.title = data.title;
  if (data.instructions !== undefined) patch.instructions = data.instructions;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.paused !== undefined) patch.paused = data.paused;
  if (data.cron !== undefined) {
    patch.cron = data.cron;
    patch.nextRunAt = nextCronRun(data.cron, data.timezone ?? owned.timezone);
  } else if (data.timezone !== undefined) {
    patch.nextRunAt = nextCronRun(owned.cron, data.timezone);
  }
  if (Object.keys(patch).length === 0) return owned;
  const [updated] = await store
    .update(routines)
    .set(patch)
    .where(and(eq(routines.id, data.routineId), eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .returning();
  if (!updated) return null;
  if (data.paused === true) {
    // Pausing parks pending jobs; they resume on unpause via the new job below.
    await store.update(jobs).set({ status: "done" }).where(and(eq(jobs.routineId, updated.id), eq(jobs.status, "pending")));
  }
  if (data.paused === false || data.cron !== undefined || data.timezone !== undefined) {
    const runAt = updated.nextRunAt;
    const [existing] = await store
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.routineId, updated.id), eq(jobs.status, "pending")));
    if (!existing && !updated.paused) {
      await store.insert(jobs).values({ accountId, routineId: updated.id, status: "pending", runAt });
    }
  }
  return updated;
}

/**
 * Deletes the calling agent's own routine and its pending jobs.
 * Why: owner-scoped like update — foreign ids read as not found.
 * Input: store, account/caller ids, routine id. Output: true when deleted.
 */
export async function deleteOwnRoutine(store: Store, accountId: string, agentId: string, routineId: string): Promise<boolean> {
  const id = routineIdSchema.parse({ routineId }).routineId;
  const [owned] = await store
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  if (!owned) return false;
  await store.delete(jobs).where(and(eq(jobs.routineId, id), eq(jobs.accountId, accountId)));
  const deleted = await store
    .delete(routines)
    .where(and(eq(routines.id, id), eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .returning({ id: routines.id });
  return deleted.length > 0;
}

/**
 * Deletes many of the calling agent's routines in one shot (or all of them).
 * Why: "remove everything" must be one Auto-review card, not N single deletes.
 * Ownership is enforced in the WHERE; unknown ids are skipped, not errors.
 * Input: store, account/caller, { all } or { routineIds }. Output: deleted count + ids.
 */
export async function deleteOwnRoutines(
  store: Store,
  accountId: string,
  agentId: string,
  input: { all?: boolean; routineIds?: string[] },
): Promise<{ deleted: number; routineIds: string[] }> {
  const owned = await store
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  const targets = input.all
    ? owned.map((row) => row.id)
    : owned.map((row) => row.id).filter((id) => (input.routineIds ?? []).includes(id));
  if (targets.length === 0) return { deleted: 0, routineIds: [] };
  await store.delete(jobs).where(and(eq(jobs.accountId, accountId), inArray(jobs.routineId, targets)));
  const removed = await store
    .delete(routines)
    .where(and(eq(routines.accountId, accountId), eq(routines.agentId, agentId), inArray(routines.id, targets)))
    .returning({ id: routines.id });
  return { deleted: removed.length, routineIds: removed.map((row) => row.id) };
}
