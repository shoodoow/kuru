/**
 * Rolling-window compaction (keeps a years-long thread sharp and inside the
 * context window). The newest RECENT_WINDOW messages ride in the prompt
 * verbatim; everything older is folded, once, into cited summary items and
 * durable facts by an LLM. A per-room watermark (`conversations.folded_through`)
 * marks the newest folded message, so each fold reads only what is new and no
 * message is ever folded twice. Original messages are never deleted.
 * DB: reads messages/memories/work_log, writes summary_items, memories,
 * conversations.folded_through.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { conversations, memories, memoryKinds, summaryItems, type MemoryKind } from "../db/schema.js";
import { factsAboutMentioned, remember, supersede } from "./memory.js";
import { mergeSummary } from "./summary.js";

type Db = ReturnType<typeof getDb>;

/** Messages folded per pass. A long backlog is worked off over several turns. */
export const FOLD_SLICE_MAX = 60;

export type SliceMessage = { id: string; agentId: string | null; body: string; createdAt?: Date };

/** A fact already in memory, shown to the summarizer so it can update instead of duplicating. */
export type KnownFact = { id: string; subject: string | null; body: string; scope?: string; agentId?: string | null };

/** A summary line still marked open, shown to the summarizer so it can say the slice settled it. */
export type OpenItem = { id: string; body: string };

export type FoldItem = { key: string; body: string; messageId: string };

export type FoldFact = {
  kind: MemoryKind;
  subject: string | null;
  body: string;
  messageId: string;
  /** Id of the known fact this one replaces. */
  replaces?: string;
};

export type FoldOutput = { items: FoldItem[]; facts?: FoldFact[]; /** Ids of open items the slice resolved. */ closed?: string[] };

/** A summarizer turns an aged-out slice into cited summary items and, optionally, durable facts. */
export type FoldSummarizer = (slice: SliceMessage[], known: KnownFact[], open?: OpenItem[]) => Promise<FoldOutput | FoldItem[]>;

/** Kinds of fact that describe the person and their world, which every one of their agents should know. */
const SHARED_KINDS = new Set(["preference", "person", "org"]);

/**
 * Whether a folded fact goes to every agent or stays with the chat's agent.
 * Why: every fact used to be shared, so one agent's working details (episode
 * numbers, render schedules, gig drafts) filled every other agent's memory
 * and pushed out what mattered to them. Facts about the person themself, the
 * people and organizations around them, and their preferences stay shared.
 */
export function sharedFact(fact: { kind: string; subject: string | null }): boolean {
  // How this agent was told to do its work stays with it, and reaches its workers.
  if (fact.kind === "procedure") return false;
  return SHARED_KINDS.has(fact.kind) || !fact.subject?.trim();
}

export type FoldResult = { key: string; body: string }[] & { factsSaved?: number; lastMessageId?: string };

/**
 * Folds messages that have just aged out of the recent window.
 * Input: db, ids, how many recent messages to keep verbatim, the minimum batch
 * before folding, and a summarizer. Output: the summary items written (empty
 * when there is nothing new to fold), with `factsSaved` and `lastMessageId`
 * attached for the caller.
 */
export async function foldAged(
  db: Db,
  accountId: string,
  conversationId: string,
  keepRecent: number,
  minBatch: number,
  summarize: FoldSummarizer,
): Promise<FoldResult> {
  // All boundaries are compared inside Postgres: its timestamps carry
  // microseconds, and a round trip through a JS Date would lose them and
  // re-fold the boundary message.
  const rows = await db.execute<{ id: string; agent_id: string | null; body: string; created_at: Date }>(sql`
    select m.id, m.agent_id, m.body, m.created_at
    from messages m
    where m.account_id = ${accountId}
      and m.conversation_id = ${conversationId}
      and m.created_at > coalesce(
        (select c.folded_through from conversations c where c.id = ${conversationId}),
        (select max(cited.created_at) from summary_items s join messages cited on cited.id = s.message_id
          where s.conversation_id = ${conversationId} and s.account_id = ${accountId}),
        '-infinity'::timestamptz
      )
      and m.created_at <= (
        select edge.created_at from messages edge
        where edge.account_id = ${accountId} and edge.conversation_id = ${conversationId}
        order by edge.created_at desc offset ${keepRecent} limit 1
      )
    order by m.created_at asc
    limit ${FOLD_SLICE_MAX}
  `);
  const slice: SliceMessage[] = rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    body: row.body,
    createdAt: new Date(row.created_at),
  }));
  if (slice.length < minBatch) return [];

  const [room] = await db
    .select({ ownerAgentId: conversations.ownerAgentId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);
  const ownerAgentId = room?.ownerAgentId ?? null;
  const known = await knownFactsFor(db, accountId, ownerAgentId, slice);
  const open = await openItemsFor(db, accountId, conversationId);
  const raw = await summarize(slice, known, open);
  const output: FoldOutput = Array.isArray(raw) ? { items: raw } : raw;
  const sliceIds = new Set(slice.map((message) => message.id));
  const lastId = slice.at(-1)!.id;
  const cite = (id: string): string => (sliceIds.has(id) ? id : lastId);

  const items = output.items
    .filter((item) => item.body.trim().length > 0)
    .map((item) => ({ ...item, messageId: cite(item.messageId) }));
  const saved = items.length > 0 ? await mergeSummary(db, accountId, conversationId, items) : [];
  if (saved.length > 0) {
    // A slice line belongs to the time its messages were written, not to the
    // moment it was folded; roll-ups and dated recall both rely on that.
    await db
      .update(summaryItems)
      .set({ periodStart: slice[0]!.createdAt, periodEnd: slice.at(-1)!.createdAt })
      .where(
        inArray(
          summaryItems.id,
          saved.map((item) => item.id),
        ),
      );
  }

  // An open line the slice settled ("waiting for the logins" after they came)
  // is removed; left in, it told the agent for days to wait for something done.
  const openIds = new Set(open.map((item) => item.id));
  const closed = (output.closed ?? []).filter((id) => openIds.has(id));
  if (closed.length > 0) {
    await db
      .delete(summaryItems)
      .where(and(eq(summaryItems.accountId, accountId), eq(summaryItems.conversationId, conversationId), inArray(summaryItems.id, closed)));
  }

  let factsSaved = 0;
  const knownById = new Map(known.map((fact) => [fact.id, fact]));
  for (const fact of output.facts ?? []) {
    const body = fact.body.trim();
    if (!body) continue;
    // An update keeps the place of the fact it replaces; a new fact is placed by what it is about.
    const replaced = fact.replaces ? knownById.get(fact.replaces) : undefined;
    const shared = replaced ? replaced.scope !== "agent" : sharedFact(fact) || !ownerAgentId;
    const row = await remember(db, accountId, {
      scope: shared ? "user" : "agent",
      agentId: shared ? null : (replaced?.agentId ?? ownerAgentId),
      body,
      messageId: cite(fact.messageId),
      kind: (memoryKinds as readonly string[]).includes(fact.kind) && fact.kind !== "profile" ? fact.kind : "fact",
      subject: fact.subject,
    });
    if (replaced && replaced.id !== row.id) {
      await supersede(db, accountId, replaced.id, row.id);
    }
    factsSaved += 1;
  }

  // Advance even when the model returned nothing usable, so one bad slice
  // cannot block every later fold.
  await db.execute(sql`
    update conversations set folded_through = (select created_at from messages where id = ${lastId})
    where id = ${conversationId} and account_id = ${accountId}
  `);
  const result: FoldResult = saved.map((item) => ({ key: item.key, body: item.body }));
  result.factsSaved = factsSaved;
  result.lastMessageId = lastId;
  return result;
}

/**
 * Facts the summarizer should see before writing new ones.
 * Why: without them it re-states what memory already holds, or records a
 * change as a second, contradicting fact. Subjects named in the slice come
 * first, then the newest shared facts.
 */
async function knownFactsFor(
  db: Db,
  accountId: string,
  ownerAgentId: string | null,
  slice: SliceMessage[],
): Promise<KnownFact[]> {
  const text = slice.map((message) => message.body).join("\n");
  const mentioned = ownerAgentId ? await factsAboutMentioned(db, accountId, ownerAgentId, text).catch(() => []) : [];
  // Shared facts and this chat's agent's own: the ones a fold may write over.
  const visible = ownerAgentId
    ? sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${ownerAgentId}))`
    : eq(memories.scope, "user");
  const newest = await db
    .select({ id: memories.id, subject: memories.subject, body: memories.body, scope: memories.scope, agentId: memories.agentId })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), visible, isNull(memories.supersededBy), sql`${memories.kind} <> 'profile'`))
    .orderBy(desc(memories.createdAt))
    .limit(16);
  const seen = new Set<string>();
  return [...mentioned, ...newest]
    .filter((fact) => (seen.has(fact.id) ? false : (seen.add(fact.id), true)))
    .slice(0, 24)
    .map((fact) => ({ id: fact.id, subject: fact.subject, body: fact.body, scope: fact.scope, agentId: fact.agentId }));
}

/** Most open lines shown to one fold. */
const OPEN_ITEMS_SHOWN = 12;

/** The chat's summary lines still marked open, newest first. */
async function openItemsFor(db: Db, accountId: string, conversationId: string): Promise<OpenItem[]> {
  return db
    .select({ id: summaryItems.id, body: summaryItems.body })
    .from(summaryItems)
    .where(
      and(
        eq(summaryItems.accountId, accountId),
        eq(summaryItems.conversationId, conversationId),
        eq(summaryItems.key, "open"),
        eq(summaryItems.level, 0),
      ),
    )
    .orderBy(desc(summaryItems.createdAt))
    .limit(OPEN_ITEMS_SHOWN);
}
