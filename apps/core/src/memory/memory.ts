import { memoryCorrectSchema, memoryFactSchema } from "@kuru/shared";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, memories, messages, type MemoryKind } from "../db/schema.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select" | "delete" | "update">;

const pageSize = 5;
/** Newest current facts shown every turn; the rest come back through recall and entity lookup. */
const standingMemoryLimit = 12;
/** Current facts pulled in for subjects named in the incoming message. */
const entityFactLimit = 12;
/** Longest brief stored for an account. */
export const BRIEF_CHARS = 4_000;

/**
 * Loads one cited message, or a short search page from one room.
 * Input: database, account id, conversation id, and either a message id or a search string.
 * Output: the matching messages, never the whole transcript. Search returns at most five rows.
 */
export async function readHistory(
  db: Database,
  accountId: string,
  conversationId: string,
  query: { messageId: string } | { search: string; limit?: number },
) {
  if ("messageId" in query) {
    return db
      .select()
      .from(messages)
      .where(
        and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.id, query.messageId)),
      );
  }
  const limit = Math.min(query.limit ?? pageSize, pageSize);
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.conversationId, conversationId),
        sql`to_tsvector('english', ${messages.body}) @@ plainto_tsquery('english', ${query.search})`,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit);
}

/**
 * Stores one fact for an agent or for the whole account, idempotently by
 * scope/agent/body so repeated model turns do not flood standing context.
 * Input: database, account id, and a fact with scope, optional agent id, body, and message id.
 * Output: the saved fact. A user fact is stored with a null agent id.
 */
export async function remember(db: Pick<Database, "insert" | "select">, accountId: string, input: unknown) {
  const fact = memoryFactSchema.parse(input);
  const extra = (input ?? {}) as { kind?: MemoryKind; subject?: string | null };
  const scopeMatch =
    fact.scope === "user" ? isNull(memories.agentId) : eq(memories.agentId, fact.agentId ?? "");
  const [existing] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        eq(memories.scope, fact.scope),
        eq(memories.body, fact.body),
        isNull(memories.supersededBy),
        scopeMatch,
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(memories)
    .values({
      accountId,
      scope: fact.scope,
      agentId: fact.scope === "user" ? null : fact.agentId,
      body: fact.body,
      messageId: fact.messageId,
      kind: extra.kind ?? "fact",
      subject: extra.subject?.trim() || null,
    })
    .returning();
  if (!row) {
    throw new Error("The memory insert returned no row.");
  }
  return row;
}

/**
 * Replaces one exact fact with a new fact that cites a new message.
 * Why: the old row is kept and pointed at its replacement, so the history of
 * what was believed stays while every reader sees only the current fact.
 * Input: database, account id, and the scope, agent, old body, new body, and new message id.
 * Output: the saved fact. The row whose body matched the old text is no longer current.
 */
export async function correct(db: Database, accountId: string, input: unknown) {
  const fact = memoryCorrectSchema.parse(input);
  const scopeMatch =
    fact.scope === "user" ? isNull(memories.agentId) : eq(memories.agentId, fact.agentId ?? "");
  const [old] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        eq(memories.scope, fact.scope),
        eq(memories.body, fact.oldBody),
        isNull(memories.supersededBy),
        scopeMatch,
      ),
    )
    .limit(1);
  const saved = await remember(db, accountId, {
    scope: fact.scope,
    agentId: fact.agentId,
    body: fact.body,
    messageId: fact.messageId,
    kind: old?.kind as MemoryKind | undefined,
    subject: old?.subject,
  });
  if (old && old.id !== saved.id) await supersede(db, accountId, old.id, saved.id);
  return saved;
}

/** Marks one fact as replaced by another. The old row stays as history. */
export async function supersede(
  db: Pick<Database, "update">,
  accountId: string,
  oldId: string,
  newId: string,
): Promise<void> {
  await db
    .update(memories)
    .set({ supersededBy: newId })
    .where(and(eq(memories.accountId, accountId), eq(memories.id, oldId), isNull(memories.supersededBy)));
}

/** Facts this agent may read: the account's shared facts plus its own. */
function visibleTo(accountId: string, agentId: string) {
  return and(
    eq(memories.accountId, accountId),
    isNull(memories.supersededBy),
    sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${agentId}))`,
  );
}

/**
 * Lists the newest current facts one agent is allowed to see.
 * Input: database, account id, and agent id.
 * Output: that agent's private facts plus the account's user facts, oldest
 * first. Replaced facts, the profile, and another account's facts are absent.
 */
export async function memoriesFor(db: Database, accountId: string, agentId: string) {
  const rows = await db
    .select()
    .from(memories)
    .where(and(visibleTo(accountId, agentId), ne(memories.kind, "profile")))
    .orderBy(desc(memories.createdAt))
    .limit(standingMemoryLimit);
  return rows.reverse();
}

/**
 * Current facts about the people, organizations and projects named in a text.
 * Why: "what did we decide about Acme?" must work in year three. Matching the
 * stored subject names against the incoming message is exact, cheap, and
 * needs no embedding key.
 * Input: database, account/agent ids, the text to scan. Output: matching facts, newest first.
 */
export async function factsAboutMentioned(db: Database, accountId: string, agentId: string, text: string) {
  const haystack = text.trim().toLowerCase().slice(0, 4_000);
  if (haystack.length < 2) return [];
  return db
    .select()
    .from(memories)
    .where(
      and(
        visibleTo(accountId, agentId),
        ne(memories.kind, "profile"),
        sql`${memories.subject} is not null and length(${memories.subject}) >= 2 and position(lower(${memories.subject}) in ${haystack}) > 0`,
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(entityFactLimit);
}

/** The pinned profile: one short standing description of the person and their world. */
export async function profileFor(db: Database, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ body: memories.body })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.kind, "profile"), isNull(memories.supersededBy)))
    .orderBy(desc(memories.createdAt))
    .limit(1);
  return row?.body ?? null;
}

/** Replaces the pinned profile. The previous one is kept as history. */
export async function saveProfile(db: Database, accountId: string, body: string, messageId: string): Promise<void> {
  const text = body.trim();
  if (!text) return;
  const previous = await db
    .select({ id: memories.id, body: memories.body })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.kind, "profile"), isNull(memories.supersededBy)));
  if (previous.some((row) => row.body === text)) return;
  const [row] = await db
    .insert(memories)
    .values({ accountId, scope: "user", agentId: null, body: text, messageId, kind: "profile" })
    .returning({ id: memories.id });
  if (!row) return;
  for (const old of previous) await supersede(db, accountId, old.id, row.id);
}

/** The account's brief: the standing page about the person, shown to every agent. */
export async function briefFor(db: Pick<Database, "select">, accountId: string): Promise<string | null> {
  const [row] = await db.select({ brief: accounts.brief }).from(accounts).where(eq(accounts.id, accountId));
  return row?.brief?.trim() || null;
}

/** Replaces the account's brief. Input: db, account id, the new text. Output: the saved text. */
export async function saveBrief(db: Pick<Database, "update">, accountId: string, brief: string): Promise<string> {
  const text = brief.trim().slice(0, BRIEF_CHARS);
  await db.update(accounts).set({ brief: text, briefUpdatedAt: new Date() }).where(eq(accounts.id, accountId));
  return text;
}

/**
 * Current facts kept by one agent only (not the account's shared facts).
 * Why: the support agent reads these to see what another agent knows before it adds or corrects a fact.
 * Input: db, account id, the agent whose memory to read. Output: newest first, at most 60.
 */
export async function agentFacts(db: Pick<Database, "select">, accountId: string, agentId: string) {
  return db
    .select({ id: memories.id, kind: memories.kind, subject: memories.subject, body: memories.body, createdAt: memories.createdAt })
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        eq(memories.scope, "agent"),
        eq(memories.agentId, agentId),
        isNull(memories.supersededBy),
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(60);
}
