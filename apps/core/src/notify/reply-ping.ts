import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, type messages } from "../db/schema.js";
import { saveNotification } from "./notify.js";

type Db = ReturnType<typeof getDb>;

/** How much of the reply the notification shows. */
const PREVIEW_CHARS = 160;

/** A reply as one plain line: no markdown marks, no line breaks. */
export function replyPreview(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_CHARS ? `${plain.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "")}…` : plain;
}

/**
 * Queues a notification for what an agent just said.
 * Why: only `notify_user` and approval requests made a notification, so a
 * reply that arrived while the person was away (a finished job, a routine, an
 * answer to a question they left) never reached their phone. Every turn that
 * ends with something said now queues one. The relay pushes it only when
 * nobody is watching the chat, and the phone shows nothing while it is open.
 * It is saved without the run's id, so it never replaces an approval request
 * the same run is waiting on.
 * Input: db, account and room ids, and the messages the turn saved.
 */
export async function pingForReply(
  db: Db,
  input: { accountId: string; conversationId: string; rows: (typeof messages.$inferSelect)[] },
): Promise<void> {
  const spoken = input.rows.filter((row) => row.agentId && replyPreview(row.body));
  const last = spoken.at(-1);
  if (!last?.agentId) return;
  const [room] = await db
    .select({ kind: conversations.kind, title: conversations.title })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  const [agent] = await db
    .select({ label: agents.label, name: agents.name })
    .from(agents)
    .where(and(inArray(agents.id, [last.agentId]), eq(agents.accountId, input.accountId)));
  const who = agent?.label || agent?.name || "Your agent";
  await saveNotification(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: last.agentId,
    messageId: last.id,
    title: room?.kind === "group" && room.title ? `${who} in ${room.title}` : who,
    body: replyPreview(last.body),
    urgency: "info",
  });
}
