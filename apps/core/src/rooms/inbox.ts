import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { conversations, delegations } from "../db/schema.js";

type Database = ReturnType<typeof getDb>;

export type InboxStatus = {
  /** One entry per chat: how many agent messages the person has not seen, and whether work is running there. */
  rooms: { id: string; kind: string; ownerAgentId: string; unread: number; working: boolean }[];
  /** Agents with a turn or background work running anywhere on the account. */
  workingAgentIds: string[];
};

/**
 * Reads what the inbox list shows beside each chat: unread count and whether the agent is busy.
 * Why: the list used to look the same whether an agent had replied, was still
 * working, or had done nothing, so the person had to open each chat to find out.
 * Input: db and account id. Output: per-chat status and the busy agents.
 */
export async function inboxStatus(db: Database, accountId: string): Promise<InboxStatus> {
  const [rooms, working] = await Promise.all([
    db
      .select({
        id: conversations.id,
        kind: conversations.kind,
        ownerAgentId: conversations.ownerAgentId,
        // Column names are written out: drizzle leaves them unqualified in a
        // single-table select, where "id" would bind to the inner table.
        unread: sql<number>`(
          select count(*)::int from messages m
          where m.conversation_id = "conversations"."id"
            and m.agent_id is not null
            and ("conversations"."last_read_at" is null or m.created_at > "conversations"."last_read_at")
        )`,
        running: sql<boolean>`exists (
          select 1 from runs r where r.conversation_id = "conversations"."id" and r.status = 'running'
        )`,
      })
      .from(conversations)
      .where(eq(conversations.accountId, accountId)),
    db
      .select({
        conversationId: delegations.conversationId,
        parentAgentId: delegations.parentAgentId,
        childAgentId: delegations.childAgentId,
      })
      .from(delegations)
      .where(and(eq(delegations.accountId, accountId), eq(delegations.status, "running"))),
  ]);
  const busyRooms = new Set(working.map((row) => row.conversationId));
  const busyAgents = new Set(working.flatMap((row) => [row.parentAgentId, row.childAgentId]));
  const result = rooms.map((room) => ({
    id: room.id,
    kind: room.kind,
    ownerAgentId: room.ownerAgentId,
    unread: room.unread,
    working: room.running || busyRooms.has(room.id),
  }));
  for (const room of result) {
    if (room.working && room.kind === "direct") busyAgents.add(room.ownerAgentId);
  }
  return { rooms: result, workingAgentIds: [...busyAgents] };
}

/**
 * Marks a chat as read up to now.
 * Input: db, account id, conversation id. Output: true, or false when the chat is outside the account.
 */
export async function markRead(db: Database, accountId: string, conversationId: string): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ lastReadAt: sql`now()` })
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}
