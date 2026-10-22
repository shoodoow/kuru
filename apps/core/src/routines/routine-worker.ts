/**
 * Routines that run as workers.
 * Why: a routine used to wake the agent with a full chat turn (brief, memory,
 * summary, recent messages) only for it to start a worker for the real job.
 * A worker routine starts the worker straight away on the background model,
 * with the brief the agent wrote, the notes the worker kept from earlier runs,
 * and the agent's saved procedures. The agent is woken only when the report
 * has something for the person.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, jobs, routines } from "../db/schema.js";
import { accountHome, exec } from "../linux/linux.js";
import { workerLessons } from "../memory/worker-lessons.js";
import { prompt } from "../prompt/prompts.js";
import { runWorker, spawnWorker, WorkerCapacityError } from "../rooms/subagents.js";
import { emitTurnBus } from "../turn/events/bus.js";
import { briefFor } from "../memory/memory.js";

type Db = ReturnType<typeof getDb>;
type Routine = typeof routines.$inferSelect;
type Job = typeof jobs.$inferSelect;

/** Most of a brief or notes file a run reads. */
const FILE_CHARS = 20_000;
const NOTES_CHARS = 6_000;
const PREVIOUS_CHARS = 1_500;

/**
 * Where a worker routine keeps its notes between runs: one file per routine, in its agent's home.
 * Left out, `home` gives the old shared place, where routines made before kept them.
 */
export function routineNotesPath(routine: { id: string; title: string }, home = "/shared"): string {
  const slug = routine.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "routine";
  return `${home}/notes/routines/${slug}-${routine.id.slice(0, 8)}.md`;
}

/**
 * Reads a text file on the agent's computer, as that agent.
 * Only paths under /shared or a home folder, never with "..".
 * Output: the text (cut to `limit`), or null when the file is missing or unreadable.
 */
export async function readAgentFile(accountId: string, profile: string | null, rawPath: string, limit = FILE_CHARS): Promise<string | null> {
  const path = profile && rawPath.startsWith("~/") ? `${accountHome(accountId, profile)}/${rawPath.slice(2)}` : rawPath;
  if (!/^(\/shared\/|\/home\/[^/]+\/)/.test(path) || path.includes("..")) return null;
  const result = await exec(accountId, ["head", "-c", String(limit), path], profile ?? "root", undefined, { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  return result.stdout;
}

/**
 * Starts the worker for one run of a worker routine and marks the job running.
 * Output: true when the worker started, false when the account already runs
 * as many workers as it may (the caller retries the job later).
 */
export async function startRoutineWorker(db: Db, routine: Routine, job: Job, opts: { skillsRoot?: string }): Promise<boolean> {
  const [agent] = await db
    .select({ linuxProfile: agents.linuxProfile })
    .from(agents)
    .where(and(eq(agents.id, routine.agentId), eq(agents.accountId, routine.accountId)));
  const profile = agent?.linuxProfile ?? null;
  // The brief file is read at every run, so editing it changes the next run.
  const fromFile = routine.briefPath ? await readAgentFile(routine.accountId, profile, routine.briefPath).catch(() => null) : null;
  const brief = fromFile?.trim() ? `${routine.instructions}\n\n${fromFile.trim()}` : routine.instructions;
  const notesPath = routineNotesPath(routine, profile ? accountHome(routine.accountId, profile) : undefined);
  // Older routines kept their notes in /shared: read them there until the agent saves its own copy.
  const oldPath = routine.notesPath ?? routineNotesPath(routine);
  const readNotes = (path: string) => readAgentFile(routine.accountId, profile, path, NOTES_CHARS).catch(() => null);
  const notes = ((await readNotes(notesPath)) ?? (oldPath !== notesPath ? await readNotes(oldPath) : null))?.trim();
  const [previous] = await db
    .select({ status: jobs.status, result: jobs.result, runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.accountId, routine.accountId), eq(jobs.routineId, routine.id), inArray(jobs.status, ["done", "failed"])))
    .orderBy(desc(jobs.runAt))
    .limit(1);
  const task = prompt("worker-rules", "routine-task", {
    title: routine.title,
    brief,
    briefFile: routine.briefPath
      ? fromFile === null
        ? `(The brief file ${routine.briefPath} could not be read, so only the summary above is known. Say so under Blockers.)\n`
        : `(From ${routine.briefPath}; the agent edits it when the job changes.)\n`
      : "",
    previous: previous
      ? `${previous.runAt.toISOString()}, ${previous.status}: ${(previous.result ?? "no report").slice(0, PREVIOUS_CHARS)}`
      : "This is the first run.",
    notes: notes || `None yet: this is the first run, or the file is missing. Create ${notesPath} at the end.`,
    notesPath,
  });
  let spawned: Awaited<ReturnType<typeof spawnWorker>>;
  try {
    spawned = await spawnWorker(db, {
      accountId: routine.accountId,
      conversationId: routine.conversationId,
      parentAgentId: routine.agentId,
      label: routine.title.slice(0, 60),
      role: `${routine.workerKind ?? "executor"} worker`,
      jobDescription: `Scheduled job: ${routine.title}`.slice(0, 200),
      task,
      kind: (routine.workerKind ?? "executor") as Parameters<typeof spawnWorker>[1]["kind"],
    });
  } catch (error) {
    if (error instanceof WorkerCapacityError) return false;
    throw error;
  }
  await db.update(jobs).set({ status: "running", delegationId: spawned.delegationId }).where(eq(jobs.id, job.id));
  const context = [
    await workerLessons(db, routine.accountId, routine.agentId, brief).catch(() => ""),
    await briefFor(db, routine.accountId)
      .then((text) => (text ? `About the person (their standing brief):\n${text.slice(0, 2_000)}` : ""))
      .catch(() => ""),
  ]
    .filter(Boolean)
    .join("\n");
  void runWorker(db, {
    accountId: routine.accountId,
    conversationId: routine.conversationId,
    parentAgentId: routine.agentId,
    childId: spawned.workerId,
    delegationId: spawned.delegationId,
    task,
    skills: routine.workerSkills,
    context,
    // A scheduled run has nobody watching to approve a preview; it runs through.
    checkpoint: false,
    skillsRoot: opts.skillsRoot,
    onSettled: (settled) => {
      void emitTurnBus({
        type: "worker.settled",
        accountId: routine.accountId,
        conversationId: routine.conversationId,
        parentAgentId: routine.agentId,
        delegationId: spawned.delegationId,
        skillsRoot: opts.skillsRoot,
        workerId: settled.workerId,
        task: settled.task,
        result: settled.result,
        status: settled.status,
      });
    },
  });
  return true;
}

/**
 * Records a finished routine worker's report as its run's result.
 * Why: the run used to be marked done when the agent's turn ended, before the
 * work it started had finished, so the next run could not tell whether the
 * job had worked. Output: whether this was a routine run, and whether its
 * report says there is nothing for the person (then nobody is woken).
 */
export async function settleRoutineRun(
  db: Db,
  delegationId: string,
  status: "done" | "failed",
  report: string,
): Promise<{ routine: boolean; quiet: boolean }> {
  const [job] = await db.select().from(jobs).where(eq(jobs.delegationId, delegationId)).limit(1);
  if (!job) return { routine: false, quiet: false };
  await db.update(jobs).set({ status, result: report.slice(0, 4_000) }).where(eq(jobs.id, job.id));
  await db.update(routines).set({ lastRunAt: new Date(), lastRunStatus: status }).where(eq(routines.id, job.routineId));
  return { routine: true, quiet: status === "done" && quietReport(report) };
}

/** True when a routine worker's report opens with NOTHING NEW and does not ask for the person. */
export function quietReport(report: string): boolean {
  const opening = report.replace(/[*_`#>\s]+/g, " ").trim().slice(0, 200).toUpperCase();
  return /^NOTHING NEW\b/.test(opening) && !/NEEDS_PERSON/.test(report) && !/FOR THE PERSON:/i.test(report);
}
