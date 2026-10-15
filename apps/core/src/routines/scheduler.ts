import type { getDb } from "../db/client.js";
import { pruneEvents } from "../rooms/events.js";
import { publish } from "../rooms/stream.js";
import { reclaimStaleRuns } from "../rooms/runs.js";
import { reclaimStaleDelegations } from "../rooms/subagents.js";
import { continueQueuedTurn, type GenerateResult, type TurnInput } from "../rooms/turn.js";
import { runDue } from "./routines.js";
import { relayNotifications } from "../notify/relay.js";
import { reflectDueAgents } from "../memory/reflection.js";

type Db = ReturnType<typeof getDb>;

export type SchedulerOptions = {
  // Why: options keep the loop testable — short intervals, injected model
  // stub, routine scoping, and a tick hook for assertions without waiting
  // wall-clock minutes.
  intervalMs?: number;
  staleMs?: number;
  eventRetentionDays?: number;
  skillsRoot?: string;
  generate?: (input: TurnInput) => Promise<GenerateResult>;
  filterJob?: (job: { id: string; routineId: string; accountId: string }) => boolean;
  onTick?: (info: { jobs: number; queued: number; reclaimed: number; notified: number }) => void;
  onError?: (error: unknown, phase: string) => void;
};

/**
 * Starts the background scheduler: due routines, stale runs, notify relay, event prune.
 * Why: single-process interval loop (15s default) — the only thing that makes
 * routines fire, crashes heal, and pings deliver with nobody watching. A chat
 * message that arrived during a turn starts when that turn ends, not on this
 * tick. Reclaiming a crashed run starts that room's waiting text, because the
 * turn that should have continued it is gone. Each phase is independently
 * try/caught so one bad room never stalls the others. Ticks never overlap.
 * Input: db + options. Output: stop() — clears the timer. Unref'd.
 */
export function startScheduler(db: Db, options: SchedulerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  const staleMs = options.staleMs ?? 120_000;
  const retentionDays = options.eventRetentionDays ?? 30;
  let inFlight = false;
  let reflecting = false;
  let stopped = false;

  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    const info = { jobs: 0, queued: 0, reclaimed: 0, notified: 0 };
    try {
      // 1. Reclaim crashed runs first so wedged rooms unblock before new work.
      try {
        const stale = await reclaimStaleRuns(db, staleMs);
        for (const run of stale) {
          publish(run.accountId, run.conversationId, {
            type: "error",
            error: "The turn stopped without finishing and was reclaimed.",
          });
        }
        info.reclaimed = stale.length;
        for (const run of stale) {
          try {
            const started = await continueQueuedTurn(
              db,
              run.accountId,
              run.conversationId,
              options.generate,
              options.skillsRoot,
              (event) => publish(run.accountId, run.conversationId, event),
            );
            if (started) info.queued += 1;
          } catch (error) {
            options.onError?.(error, "reclaim");
          }
        }
      } catch (error) {
        options.onError?.(error, "reclaim");
      }
      // Workers use their own long threshold (hours), not the 2-minute run
      // window — a live investigation must not read as a crash.
      try {
        const wedged = await reclaimStaleDelegations(db);
        info.reclaimed += wedged.length;
      } catch (error) {
        options.onError?.(error, "workers");
      }
      // 2. Fire all due routine jobs sequentially (ledger serializes rooms).
      // runDue publishes live fanout itself; the event log always records.
      try {
        for (;;) {
          const replies = await runDue(db, {
            generate: options.generate,
            skillsRoot: options.skillsRoot,
            publish: true,
            filterJob: options.filterJob,
          }).catch((error: unknown) => {
            options.onError?.(error, "routine");
            return null;
          });
          if (!replies) break;
          info.jobs += 1;
        }
      } catch (error) {
        options.onError?.(error, "routine");
      }
      // 2b. Nightly reflection: agents improve what they know from their day.
      // Off until switched on with REFLECTION_ENABLED=1, so its first results can be reviewed.
      // It runs beside the tick, one agent at a time: a reflection can take minutes,
      // and notifications and routines must not wait for it.
      if (process.env.REFLECTION_ENABLED === "1" && !reflecting) {
        reflecting = true;
        void reflectDueAgents(db, 1)
          .catch((error: unknown) => options.onError?.(error, "reflect"))
          .finally(() => {
            reflecting = false;
          });
      }
      // 3. Relay pending pings (push or in-app per policy).
      try {
        const counts = await relayNotifications(db);
        info.notified = counts.sent + counts.pushed;
      } catch (error) {
        options.onError?.(error, "notify");
      }
      // 4. Prune the resume buffer so the events table stays small.
      try {
        await pruneEvents(db, retentionDays);
      } catch (error) {
        options.onError?.(error, "prune");
      }
    } finally {
      inFlight = false;
      if (!stopped) options.onTick?.(info);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
