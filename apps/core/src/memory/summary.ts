import { summaryItemSchema } from "@kuru/shared";
import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { messages, summaryItems } from "../db/schema.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select">;

type SliceMessage = { id: string; body: string };

/**
 * Adds cited summary items for one room.
 * Input: database, account id, conversation id, and items that each carry a key, a body, and a message id.
 * Output: the saved items, one per input. Existing messages are left as they are.
 */
export async function mergeSummary(db: Database, accountId: string, conversationId: string, items: unknown[]) {
  const parsed = items.map((item) => summaryItemSchema.parse(item));
  if (parsed.length === 0) {
    return [];
  }
  return db
    .insert(summaryItems)
    .values(
      parsed.map((item) => ({
        accountId,
        conversationId,
        key: item.key,
        body: item.body,
        messageId: item.messageId,
      })),
    )
    .returning();
}

/**
 * Folds the oldest messages into the summary when the room is past the recent limit.
 * Input: database, account id, conversation id, the number of recent messages to leave unfolded, and a summarizer.
 * Output: the summary items written for that oldest slice. The original messages stay selectable.
 */
export async function foldOldest(
  db: Database,
  accountId: string,
  conversationId: string,
  limit: number,
  summarize: (slice: SliceMessage[]) => Promise<{ key: string; body: string; messageId: string }[]>,
) {
  const history = await db
    .select()
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
  if (history.length <= limit) {
    return [];
  }
  const oldest = history.slice(0, history.length - limit);
  const items = await summarize(oldest.map((message) => ({ id: message.id, body: message.body })));
  return mergeSummary(db, accountId, conversationId, items);
}
