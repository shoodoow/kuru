/**
 * Roll-ups and the pinned profile: the two things that keep memory useful
 * after years. Slice summaries pile up by the hundreds; a finished month is
 * condensed into one digest and finished years into one more, so the prompt
 * can always carry the long arc in a few lines while details stay reachable
 * by search. The profile is one short standing description of the person and
 * their world, rewritten when new facts land.
 * DB: reads/writes summary_items and memories.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { memories, summaryItems } from "../db/schema.js";
import { prompt } from "../prompt/prompts.js";
import { briefFor, profileFor, saveProfile } from "./memory.js";

type Db = ReturnType<typeof getDb>;

/** Turns a system instruction and a user text into plain text ("" on failure). */
export type Writer = (system: string, user: string) => Promise<string>;

/** A period is condensed only when it holds at least this many lines. */
const ROLLUP_MIN_ITEMS = 3;
const DIGEST_CHARS = 900;
const PROFILE_CHARS = 1_500;
const PROFILE_FACTS = 80;

/**
 * Condenses the oldest finished period that has no digest yet.
 * Input: db, ids, a writer, the level to produce (1 = month from slices,
 * 2 = year from months), and the current time.
 * Output: the digest row written, or null when nothing is due. One period per call.
 */
export async function rollUp(
  db: Db,
  accountId: string,
  conversationId: string,
  write: Writer,
  level: 1 | 2,
  now: Date = new Date(),
): Promise<{ body: string; periodStart: Date } | null> {
  const unit = level === 1 ? "month" : "year";
  const sourceLevel = level - 1;
  const minItems = level === 1 ? ROLLUP_MIN_ITEMS : 2;
  const due = await db.execute<{ period: Date }>(sql`
    select date_trunc(${unit}, coalesce(s.period_start, s.created_at)) as period
    from summary_items s
    where s.account_id = ${accountId} and s.conversation_id = ${conversationId} and s.level = ${sourceLevel}
      and date_trunc(${unit}, coalesce(s.period_start, s.created_at)) < date_trunc(${unit}, ${now.toISOString()}::timestamptz)
      and not exists (
        select 1 from summary_items d
        where d.conversation_id = s.conversation_id and d.level = ${level}
          and d.period_start = date_trunc(${unit}, coalesce(s.period_start, s.created_at))
      )
    group by 1
    having count(*) >= ${minItems}
    order by 1 asc
    limit 1
  `);
  const period = due[0]?.period;
  if (!period) return null;
  const periodStart = new Date(period);
  const periodEnd = new Date(periodStart);
  if (level === 1) periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  else periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);

  const source = await db
    .select({ key: summaryItems.key, body: summaryItems.body, messageId: summaryItems.messageId })
    .from(summaryItems)
    .where(
      and(
        eq(summaryItems.accountId, accountId),
        eq(summaryItems.conversationId, conversationId),
        eq(summaryItems.level, sourceLevel),
        sql`coalesce(${summaryItems.periodStart}, ${summaryItems.createdAt}) >= ${periodStart.toISOString()}::timestamptz`,
        sql`coalesce(${summaryItems.periodStart}, ${summaryItems.createdAt}) < ${periodEnd.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(summaryItems.createdAt));
  if (source.length === 0) return null;
  const label = level === 1 ? periodStart.toISOString().slice(0, 7) : periodStart.toISOString().slice(0, 4);
  const lines = source.map((item) => `- ${item.key}: ${item.body.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  const written = await write(prompt("memory", "rollup"), prompt("memory", "rollup-user", { period: label, lines }));
  // A failed model call still closes the period, with the plain lines, so it is not retried forever.
  const body = (written || lines).slice(0, DIGEST_CHARS);
  await db.insert(summaryItems).values({
    accountId,
    conversationId,
    key: "topics",
    body: `${label}: ${body}`,
    messageId: source.at(-1)!.messageId,
    level,
    periodStart,
    periodEnd,
  });
  return { body, periodStart };
}

/**
 * Rewrites the pinned profile from the current shared facts.
 * Input: db, account id, a writer, and the message to cite.
 * Output: nothing. With no facts or an empty model answer the profile is left as it is.
 */
export async function refreshProfile(db: Db, accountId: string, write: Writer, messageId: string): Promise<void> {
  const facts = await db
    .select({ kind: memories.kind, subject: memories.subject, body: memories.body })
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        eq(memories.scope, "user"),
        isNull(memories.supersededBy),
        sql`${memories.kind} <> 'profile'`,
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(PROFILE_FACTS);
  if (facts.length === 0) return;
  const previous = (await profileFor(db, accountId)) ?? "(none yet)";
  const lines = facts
    .reverse()
    .map((fact) => `- ${fact.kind}${fact.subject ? ` | ${fact.subject}` : ""}: ${fact.body.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const brief = (await briefFor(db, accountId)) ?? "(none yet)";
  const written = await write(prompt("memory", "profile"), prompt("memory", "profile-user", { brief, previous, facts: lines }));
  if (!written) return;
  await saveProfile(db, accountId, written.slice(0, PROFILE_CHARS), messageId);
}
