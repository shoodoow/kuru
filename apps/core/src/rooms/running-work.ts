/**
 * What one agent has running right now, for the "Running now" part of its page.
 * Why: the app showed an agent as busy with no way to see on what, and the
 * agent itself sometimes said "nothing is running" while a routine was at work.
 * This reads the rows, not the agent's word.
 * DB: reads `delegations` (background jobs) and `runs` (chat turns), scoped by account.
 */
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, delegations, runs } from "../db/schema.js";
import { isWorkerLive } from "./subagents.js";

type Db = ReturnType<typeof getDb>;

export type RunningJob = {
  /** The worker's id, used to stop it. */
  workerId: string;
  title: string;
  /** The whole brief the worker was given for this run, exactly as its agent wrote it. */
  brief: string;
  /** "routine" when a schedule started it, "job" when the agent did. */
  source: "routine" | "job";
  status: "running" | "lost" | "done" | "failed";
  progress: string;
  steps: number;
  startedAt: string;
  lastActivityAt: string;
  result?: string;
};

export type RunningWork = {
  /** True while the agent itself is writing a reply in one of its chats. */
  replying: boolean;
  running: RunningJob[];
  /** Jobs that ended in the last day, newest first, so a job that just finished does not vanish without a trace. */
  recent: RunningJob[];
};

const ROUTINE_HEAD = "Scheduled job:";
const RECENT_MS = 24 * 60 * 60 * 1000;
/** Briefs are rarely over 10K; this only guards the response against a runaway one. */
const BRIEF_MAX_CHARS = 60_000;

/** First meaningful line of a brief: the routine's name, or the start of the job. */
function jobTitle(task: string): string {
  const first = task.trim().split("\n")[0] ?? "";
  const named = first.startsWith(ROUTINE_HEAD) ? first.slice(ROUTINE_HEAD.length).split(". This run")[0]! : first;
  const clean = named.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean || "Background job";
}

/**
 * Lists an agent's running background jobs, the ones that ended in the last day, and whether it is replying.
 * Input: db, account id, agent id. Output: the work, or null when the agent is not on the account.
 */
export async function runningWork(db: Db, accountId: string, agentId: string): Promise<RunningWork | null> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) return null;
  const rows = await db
    .select()
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.parentAgentId, agentId),
        gt(delegations.createdAt, new Date(Date.now() - 7 * RECENT_MS)),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(40);
  const job = (row: (typeof rows)[number]): RunningJob => {
    const running = row.status === "running";
    return {
      workerId: row.childAgentId,
      title: jobTitle(row.task),
      brief: row.task.length > BRIEF_MAX_CHARS ? `${row.task.slice(0, BRIEF_MAX_CHARS)}\n…` : row.task,
      source: row.task.trimStart().startsWith(ROUTINE_HEAD) ? "routine" : "job",
      status: running ? (isWorkerLive(row.id) ? "running" : "lost") : (row.status as "done" | "failed"),
      progress: (row.progress ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      steps: row.modelSteps ?? 0,
      startedAt: row.createdAt.toISOString(),
      lastActivityAt: row.heartbeatAt.toISOString(),
      ...(running ? {} : { result: (row.result ?? "").replace(/\s+/g, " ").trim().slice(0, 400) }),
    };
  };
  const cutoff = Date.now() - RECENT_MS;
  const running = rows.filter((row) => row.status === "running").map(job);
  const recent = rows
    .filter((row) => row.status !== "running" && row.heartbeatAt.getTime() > cutoff)
    .slice(0, 5)
    .map(job);

  const chats = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.ownerAgentId, agentId), ne(conversations.kind, "group")));
  const busy = chats.length
    ? await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.accountId, accountId), eq(runs.status, "running"), inArray(runs.conversationId, chats.map((chat) => chat.id))))
        .limit(1)
    : [];
  return { replying: busy.length > 0, running, recent };
}
