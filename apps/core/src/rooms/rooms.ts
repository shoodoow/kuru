import { memberAddSchema, messageCreateSchema, roomCreateSchema, sendMessageInputSchema } from "@kuru/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { getDb, Store } from "../db/client.js";
import {
  agents,
  conversations,
  delegations,
  events,
  jobs,
  members,
  messages,
  notifications,
  reactions,
  routines,
  runs,
  summaryItems,
} from "../db/schema.js";
import type { MessageBlock } from "@kuru/shared";
import { materializeBlocks } from "./uploads.js";

type Database = ReturnType<typeof getDb>;

export class RoomCapacityError extends Error {
  constructor() {
    super("A room cannot have more than 20 members");
    this.name = "RoomCapacityError";
  }
}

/**
 * Finds one room on one account.
 * Why: every room route starts by proving the room belongs to the caller; one
 * lookup keeps that check identical everywhere.
 * Input: store, account id, conversation id. Output: the room, or null outside the account.
 */
export async function findRoom(store: Store, accountId: string, conversationId: string) {
  const [room] = await store
    .select({ id: conversations.id, kind: conversations.kind, ownerAgentId: conversations.ownerAgentId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  return room ?? null;
}

/**
 * Opens a direct chat or a group inside one account.
 * Input: a database client, the account id, and the room kind, title, owner, and member ids.
 * Output: the saved conversation and its members, or null when an agent is outside the account.
 */
export async function createRoom(db: Database, accountId: string, input: unknown) {
  const data = roomCreateSchema.parse(input);
  const agentIds = [...new Set([data.ownerAgentId, ...data.memberAgentIds])];
  if (agentIds.length > 20) {
    throw new RoomCapacityError();
  }
  // Room integrity: a private chat stays 1:1 — exactly the owner, no team.
  // Teams form in groups the agent creates with createGroupRoom.
  if (data.kind === "direct" && agentIds.length > 1) {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), inArray(agents.id, agentIds)));
  if (owned.length !== agentIds.length) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [room] = await tx
      .insert(conversations)
      .values({
        accountId,
        kind: data.kind,
        ownerAgentId: data.ownerAgentId,
        title: data.title,
      })
      .returning();
    if (!room) {
      throw new Error("The room insert returned no row.");
    }
    const roomMembers = await tx
      .insert(members)
      .values(agentIds.map((agentId) => ({ conversationId: room.id, accountId, agentId })))
      .returning();
    return { ...room, members: roomMembers };
  });
}

/**
 * Opens a GROUP room owned by the caller with the given members.
 * Why: the only room-creation path model tools may call — structurally
 * incapable of touching 1:1 chats. Private chats stay 1:1 because no tool
 * exists that adds to them; teams always form in fresh groups.
 * Input: store, account id, owner agent id, title, member agent ids.
 * Output: the saved conversation + members. Throws on foreign members or >20 total.
 */
export async function createGroupRoom(
  store: Store,
  input: { accountId: string; ownerAgentId: string; title: string; memberIds: string[] },
) {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error("Group title must be 1-200 characters.");
  const agentIds = [...new Set([input.ownerAgentId, ...input.memberIds])];
  if (agentIds.length > 20) throw new RoomCapacityError();
  const owned = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, input.accountId), inArray(agents.id, agentIds)));
  if (owned.length !== agentIds.length) {
    throw new Error("Unknown agent id — invite only agents on this account.");
  }
  const [room] = await store
    .insert(conversations)
    .values({ accountId: input.accountId, kind: "group", ownerAgentId: input.ownerAgentId, title })
    .returning();
  if (!room) throw new Error("The room insert returned no row.");
  const roomMembers = await store
    .insert(members)
    .values(agentIds.map((agentId) => ({ conversationId: room.id, accountId: input.accountId, agentId })))
    .returning();
  return { ...room, members: roomMembers };
}

/**
 * Lists group rooms the agent belongs to (not direct chats).
 */
export async function listGroupRoomsForAgent(store: Store, accountId: string, agentId: string) {
  const rows = await store
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      ownerAgentId: conversations.ownerAgentId,
    })
    .from(conversations)
    .innerJoin(
      members,
      and(
        eq(members.conversationId, conversations.id),
        eq(members.accountId, accountId),
        eq(members.agentId, agentId),
      ),
    )
    .where(and(eq(conversations.accountId, accountId), eq(conversations.kind, "group")))
    .orderBy(asc(conversations.createdAt));
  return rows.map((row) => ({
    conversationId: row.conversationId,
    title: row.title,
    owned: row.ownerAgentId === agentId,
  }));
}

/**
 * Deletes a group the owner agent created. Refuses direct chats and active room.
 */
export async function deleteGroupRoom(
  db: Database,
  input: { accountId: string; ownerAgentId: string; conversationId: string; activeConversationId?: string },
) {
  if (input.conversationId === input.activeConversationId) {
    throw new Error("Cannot delete the room you are in — finish this chat or open another room first.");
  }
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Group not found.");
  if (room.kind !== "group") throw new Error("Only group rooms can be deleted — private chats stay 1:1.");
  if (room.ownerAgentId !== input.ownerAgentId) {
    throw new Error("Only the group owner can delete it.");
  }

  await db.transaction(async (tx) => {
    const routineRows = await tx
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.accountId, input.accountId), eq(routines.conversationId, input.conversationId)));
    const routineIds = routineRows.map((row) => row.id);
    if (routineIds.length > 0) {
      await tx.delete(jobs).where(and(eq(jobs.accountId, input.accountId), inArray(jobs.routineId, routineIds)));
      await tx.delete(routines).where(inArray(routines.id, routineIds));
    }
    await tx
      .delete(notifications)
      .where(and(eq(notifications.accountId, input.accountId), eq(notifications.conversationId, input.conversationId)));
    await tx.delete(events).where(and(eq(events.accountId, input.accountId), eq(events.conversationId, input.conversationId)));
    await tx.delete(runs).where(and(eq(runs.accountId, input.accountId), eq(runs.conversationId, input.conversationId)));
    await tx
      .delete(delegations)
      .where(and(eq(delegations.accountId, input.accountId), eq(delegations.conversationId, input.conversationId)));
    await tx
      .delete(summaryItems)
      .where(and(eq(summaryItems.accountId, input.accountId), eq(summaryItems.conversationId, input.conversationId)));
    await tx.execute(
      sql`delete from reactions where account_id = ${input.accountId} and message_id in (select id from messages where conversation_id = ${input.conversationId} and account_id = ${input.accountId})`,
    );
    await tx
      .delete(messages)
      .where(and(eq(messages.accountId, input.accountId), eq(messages.conversationId, input.conversationId)));
    await tx
      .delete(members)
      .where(and(eq(members.accountId, input.accountId), eq(members.conversationId, input.conversationId)));
    await tx
      .delete(conversations)
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  });

  return { deleted: true, conversationId: input.conversationId };
}

/**
 * Adds one agent to a room that this account owns.
 * Input: a database client, the account id, the conversation id, and a body with an agent id.
 * Output: the saved member, or null when the room or agent is outside the account.
 */
export async function addMember(db: Database, accountId: string, conversationId: string, input: unknown) {
  const data = memberAddSchema.parse(input);
  const room = await findRoom(db, accountId, conversationId);
  if (!room) {
    return null;
  }
  // Room integrity: nobody is ever added to a 1:1 — by tool or HTTP.
  // Teams form in groups the agent creates with create_group.
  if (room.kind === "direct") {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    return null;
  }
  const existing = await db
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));
  if (existing.some((member) => member.agentId === data.agentId)) {
    return existing.find((member) => member.agentId === data.agentId) ?? null;
  }
  if (existing.length >= 20) {
    throw new RoomCapacityError();
  }
  const [row] = await db
    .insert(members)
    .values({ conversationId, accountId, agentId: data.agentId })
    .returning();
  return row ?? null;
}

/**
 * Reads one user message for a room this account owns.
 * Why: accepts legacy {body} and new {blocks, replyTo}; returns text for the
 * turn engine plus rich passthrough so user-sent images render like agent ones.
 * Input: unknown JSON. Output: {text, blocks?, replyTo?}, or null outside account.
 */
export async function readMessage(db: Database, accountId: string, conversationId: string, input: unknown) {
  if (!(await findRoom(db, accountId, conversationId))) {
    return null;
  }
  if (typeof input === "object" && input !== null && "blocks" in input) {
    const rich = sendMessageInputSchema.parse(input);
    const text = rich.blocks
      .map((block) =>
        block.kind === "text" ? block.markdown : block.kind === "code" ? block.code : `[${block.kind}]`,
      )
      .join("\n\n");
    return { text, blocks: rich.blocks, replyTo: rich.replyTo ?? null };
  }
  const data = messageCreateSchema.parse(input);
  return { text: data.body, blocks: null, replyTo: null };
}

/**
 * Lists the chats on one account.
 * Input: a database client and the account id.
 * Output: that account's conversations. Another account's rooms are omitted.
 */
export async function listConversations(db: Database, accountId: string) {
  return db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      title: conversations.title,
      ownerAgentId: conversations.ownerAgentId,
      // Group rooms: the team's shared brief, shown on the group's profile.
      brief: conversations.brief,
    })
    .from(conversations)
    .where(eq(conversations.accountId, accountId));
}

/**
 * Lists one room's member agent ids.
 * Why: the phone shows group titles with member names instead of a single
 * owner's name — opening a group previously looked like the wrong 1:1 chat.
 * Input: db, account id, conversation id. Output: member rows, or null outside account.
 */
export async function listMembers(db: Database, accountId: string, conversationId: string) {
  if (!(await findRoom(db, accountId, conversationId))) {
    return null;
  }
  return db
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));
}

/**
 * Saves one user message synchronously (outside the turn transaction).
 * Why: POST /messages used to insert the user text inside the background
 * runTurn, so the phone's safety refresh could run before the insert and wipe
 * the optimistic bubble — the message "vanished". Durable-first ordering
 * (insert, then 202 + background turn) makes the message impossible to lose:
 * every later refresh finds it.
 * Input: db, account/conversation ids, {text, blocks?, replyTo?, runId?, queued?}.
 * Output: the saved row, or null when the room is outside the account.
 */
export async function saveUserMessage(
  db: Database,
  accountId: string,
  conversationId: string,
  input: {
    text: string;
    blocks?: MessageBlock[] | null;
    replyTo?: string | null;
    runId?: string | null;
    queued?: boolean;
  },
) {
  if (!(await findRoom(db, accountId, conversationId))) {
    return null;
  }
  if (input.replyTo) {
    const [parent] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.replyTo),
          eq(messages.conversationId, conversationId),
          eq(messages.accountId, accountId),
        ),
      );
    if (!parent) {
      throw new Error("replyTo message is not in this room.");
    }
  }
  const [saved] = await db
    .insert(messages)
    .values({
      accountId,
      conversationId,
      agentId: null,
      runId: input.runId ?? null,
      queued: input.queued ?? false,
      body: input.text,
      kind: input.blocks && input.blocks.length > 0 ? "rich" : "text",
      payload: input.blocks && input.blocks.length > 0 ? input.blocks : null,
      replyTo: input.replyTo ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error("The message insert returned no row.");
  }
  // Land attachments on the account Linux before anyone reads the thread: the
  // agent then works with /shared/uploads paths instead of megabytes of
  // base64. Best-effort — a computer outage degrades to inline blocks, and
  // the message itself is already durable so nothing is lost.
  if (input.blocks && input.blocks.length > 0) {
    try {
      const landed = await materializeBlocks(accountId, saved.id, input.blocks);
      const changed = JSON.stringify(landed) !== JSON.stringify(input.blocks);
      if (changed) {
        const [updated] = await db
          .update(messages)
          .set({ payload: landed })
          .where(and(eq(messages.id, saved.id), eq(messages.accountId, accountId)))
          .returning();
        if (updated) return updated;
      }
    } catch {
      // Computer unavailable; inline blocks still carry the content.
    }
  }
  return saved;
}
/**
 * Claims every queued user message in one room.
 * Why: a message that arrived while the room was busy must start as soon as
 * the running turn ends. One UPDATE..RETURNING flips them so the ending turn
 * and a crash reclaim cannot both start the same text.
 * Input: db, account id, conversation id. Output: claimed rows oldest-first.
 */
export async function claimQueuedForRoom(db: Database, accountId: string, conversationId: string) {
  const pending = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.queued, true), eq(messages.accountId, accountId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
  const claimed = await db
    .update(messages)
    .set({ queued: false })
    .where(inArray(messages.id, pending))
    .returning();
  return claimed.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}
/**
 * Maximum inline data: chars per block in list responses.
 * Why: a 5MB phone photo as base64 balloons every thread refresh. Blocks
 * above this budget keep metadata + blobRef; the client fetches bytes lazily
 * once and caches them.
 */
export const INLINE_BLOB_BUDGET = 200_000;

/**
 * The payload column for list queries, with oversized attachments already
 * taken out by Postgres.
 * Why: stripping in JavaScript still pulled every large attachment across
 * the connection and through JSON.parse on each sync of an open chat. Here
 * the bytes never leave the database. The result has the same shape
 * stripBloatedBlocks gives; rows without a large attachment are returned
 * untouched and are not unpacked at all.
 */
const heavyData = (value: ReturnType<typeof sql>) => sql`(${value} like 'data:%' and length(${value}) > ${INLINE_BLOB_BUDGET})`;
const listPayload = sql<unknown>`case
  when ${messages.payload} is null or jsonb_typeof(${messages.payload}) <> 'array' or pg_column_size(${messages.payload}) <= ${INLINE_BLOB_BUDGET / 2}
    then ${messages.payload}
  else (
    select jsonb_agg(
      case
        when block->>'kind' in ('image', 'file') and (${heavyData(sql`block->>'url'`)} or ${heavyData(sql`block->>'previewUrl'`)})
          then block
            || jsonb_build_object('blobRef', jsonb_build_object('messageId', ${messages.id}, 'index', position - 1))
            || case when ${heavyData(sql`block->>'url'`)} then '{"url": ""}'::jsonb else '{}'::jsonb end
            || case when ${heavyData(sql`block->>'previewUrl'`)} then '{"previewUrl": ""}'::jsonb else '{}'::jsonb end
        else block
      end
      order by position
    )
    from jsonb_array_elements(${messages.payload}) with ordinality as blocks(block, position)
  )
end`;

/**
 * Strips oversized data: URLs from blocks for list responses.
 * Why: pure function so the budget rule is unit-tested without Docker. The
 * stored row is untouched — only the wire copy shrinks. Small data URIs and
 * https URLs pass through; oversized ones become {url:"", blobRef}.
 * Input: message id + validated blocks. Output: wire-safe blocks.
 */
export function stripBloatedBlocks(messageId: string, blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block, index) => {
    if (typeof block !== "object" || block === null) return block;
    const kind = (block as { kind?: string }).kind;
    if (kind !== "image" && kind !== "file") return block;
    const record = block as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    const preview = typeof record.previewUrl === "string" ? record.previewUrl : "";
    // A file streamed from the agent's computer: the phone gets a reference
    // to ask for it by, never the path it is kept at.
    if (record.remote === true) return { ...record, url: "", blobRef: { messageId, index } };
    const heavy = (value: string) => value.startsWith("data:") && value.length > INLINE_BLOB_BUDGET;
    if (!heavy(url) && !heavy(preview)) return block;
    return {
      ...record,
      url: heavy(url) ? "" : url,
      ...(preview !== undefined ? { previewUrl: heavy(preview) ? "" : preview } : {}),
      blobRef: { messageId, index },
    };
  });
}

/**
 * Reads one message row this account owns in this room.
 * Why: the blob endpoint serves a single message's bytes; ownership must be
 * re-checked per request, never trusted from the client.
 * Input: db, account/conversation/message ids. Output: the row or null.
 */
export async function getMessage(db: Database, accountId: string, conversationId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.accountId, accountId),
      ),
    );
  return row ?? null;
}
/**
 * Lists the saved messages in one room with rich payloads.
 * Why: the phone renders blocks/images/widgets inline; body stays as text
 * fallback for search and legacy clients. Reactions are fetched separately to
 * keep the hot path small.
 * A page asks for the newest `limit` messages, or the `limit` just before
 * one message, so an open chat never re-downloads its whole history.
 * Input: a database client, the account id, the conversation id, and an optional page.
 * Output: the messages in time order with kind/payload/replyTo/via, or null outside account.
 */
export async function listMessages(
  db: Database,
  accountId: string,
  conversationId: string,
  page?: { limit?: number; before?: string },
) {
  if (!(await findRoom(db, accountId, conversationId))) {
    return null;
  }
  const inRoom = and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId));
  // Compared inside Postgres: a timestamp read into JavaScript loses its
  // microseconds, and two messages in the same millisecond would be skipped.
  const older = page?.before
    ? sql`(${messages.createdAt}, ${messages.id}) < (select m.created_at, m.id from messages m where m.id = ${page.before} and m.conversation_id = ${conversationId} and m.account_id = ${accountId})`
    : undefined;
  const query = db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      body: messages.body,
      kind: messages.kind,
      payload: listPayload,
      replyTo: messages.replyTo,
      viaAgentId: messages.viaAgentId,
      sourceConversationId: messages.sourceConversationId,
      relayKind: messages.relayKind,
      relayPeers: messages.relayPeers,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(inRoom, older));
  const rows = page?.limit
    ? (await query.orderBy(desc(messages.createdAt), desc(messages.id)).limit(clampPage(page.limit))).reverse()
    : await query.orderBy(asc(messages.createdAt), asc(messages.id));
  // Oversized data: URLs were already replaced by lazy blobRefs in the query.
  // The stored rows are untouched; the phone fetches bytes per image on demand.
  // The pass here is a second check that costs nothing on stripped rows.
  return rows.map((row) => ({ ...row, payload: stripBloatedBlocks(row.id, row.payload) }));
}

export const MAX_MESSAGE_PAGE = 200;

function clampPage(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), MAX_MESSAGE_PAGE);
}

/**
 * Lists tapbacks for messages in one room.
 * Why: reactions render under bubbles without re-fetching threads.
 * Input: db, account id, conversation id. Output: reactions in time order.
 */
export async function listReactions(db: Database, accountId: string, conversationId: string) {
  const rows = await db
    .select({ reaction: reactions })
    .from(reactions)
    .innerJoin(messages, eq(messages.id, reactions.messageId))
    .where(
      and(eq(reactions.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)),
    )
    .orderBy(asc(reactions.createdAt));
  return rows.map((row) => row.reaction);
}
