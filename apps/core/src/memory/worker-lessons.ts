import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { prompt } from "../prompt/prompts.js";
import { factsAboutMentioned } from "./memory.js";

type Db = ReturnType<typeof getDb>;

/** Most procedures one worker receives; the newest win. */
const MAX_PROCEDURES = 20;
/** The whole block stays small, since a worker resends it on every step. */
const LESSONS_CHARS = 4_000;
const LINE_CHARS = 400;

/**
 * What the agent has been told about how to do its work, for a worker it starts.
 * Why: workers get no memory, only the brief the agent writes. A rule the
 * person taught in chat ("use X when you do Y") reached a worker only when the
 * agent remembered to copy it into the brief, and it often did not. The
 * agent's procedures, and current facts about whoever the task names, are
 * now attached to every worker it starts, looked up at start time, so a rule
 * taught yesterday applies to tonight's routine without anyone rewriting it.
 * Input: db, account and agent ids, and the task text. Output: the block, or "" when there is nothing.
 */
export async function workerLessons(db: Db, accountId: string, agentId: string, task: string): Promise<string> {
  const procedures = await db
    .select({ body: memories.body, createdAt: memories.createdAt })
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        isNull(memories.supersededBy),
        eq(memories.kind, "procedure"),
        sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${agentId}))`,
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(MAX_PROCEDURES);
  const about = await factsAboutMentioned(db, accountId, agentId, task).catch(() => []);
  const seen = new Set<string>();
  const lines: string[] = [];
  let room = LESSONS_CHARS;
  for (const fact of [...procedures, ...about.slice(0, 8)]) {
    const body = fact.body.replace(/\s+/g, " ").trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    const line = `- ${body.length > LINE_CHARS ? `${body.slice(0, LINE_CHARS).replace(/\s+\S*$/, "")}…` : body} (${fact.createdAt.toISOString().slice(0, 10)})`;
    if (line.length > room) break;
    room -= line.length;
    lines.push(line);
  }
  return lines.length > 0 ? prompt("worker-rules", "context-lessons", { lines: lines.join("\n") }) : "";
}
