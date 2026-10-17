import { chartData, type MessageBlock } from "@kuru/shared";
import { reactionSchema, sendMessageInputSchema } from "@kuru/agent-tools";
import { and, asc, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { agents, conversations, members, messages, type notifications, reactions, type runs } from "../db/schema.js";
import { mentionedIds } from "./mentions.js";
import { appendEvent } from "./events.js";
import { publish } from "./stream.js";

export type RelayPeer = { id: string; label: string };

/** True when body @mentions one of the given agent names (exact token match). */
export function bodyMentionsName(body: string, names: string[]): boolean {
  const wanted = new Set(names.map((name) => name.trim()).filter(Boolean));
  if (wanted.size === 0) return false;
  for (const match of body.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    if (wanted.has(match[1] ?? "")) return true;
  }
  return false;
}

// Single voice/event vocabulary for turns (Phase 11-14). Why: one union used
// by tool executes, the run loop, SSE fanout, and the durable event log —
// replay and live share the shape, so a future Redis Streams layer slots in
// without client changes. `done` stays live-only (run events persist terminal
// state for resume).
export type TurnEvent =
  | { type: "message"; message: typeof messages.$inferSelect }
  | { type: "reaction"; reaction: typeof reactions.$inferSelect }
  | { type: "run"; run: Pick<typeof runs.$inferSelect, "id" | "status" | "error"> }
  | { type: "notify"; notification: typeof notifications.$inferSelect }
  | { type: "error"; error: string }
  | { type: "done" };

/**
 * Returns the blocks with new fields merged into every widget of one kind.
 * Why: answering a question card or deciding an approval card changes the
 * card that is already in the thread; both do it the same way.
 * Input: a message's blocks, the widget name, and the fields to set.
 */
export function withWidgetProps(
  blocks: MessageBlock[],
  widget: Extract<MessageBlock, { kind: "widget" }>["widget"],
  props: Record<string, unknown>,
): MessageBlock[] {
  return blocks.map((block) =>
    block.kind === "widget" && block.widget === widget ? { ...block, props: { ...block.props, ...props } } : block,
  );
}

/**
 * Describes one widget in words, for the stored message body.
 * Why: the body is what the agent reads back as its own history. A bare
 * `[widget:question]` hid what it had asked, and the model then copied that
 * placeholder into its next reply as plain text instead of sending a card.
 * A sentence with the question, the choices and the answer reads as history,
 * not as a format to imitate.
 * Input: widget name and props. Output: one line of text.
 */
export function widgetAsText(widget: string, props: Record<string, unknown>): string {
  const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const labels = (Array.isArray(props.options) ? props.options : [])
    .map((option) => (typeof option === "string" ? option : text((option as { label?: unknown } | null)?.label)))
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 8);
  const title = text(props.prompt) || text(props.title) || text(props.question) || text(props.message);
  if (widget === "question" || widget === "poll") {
    const picked = text(props.selected);
    return [
      `(Shown to the person as a tappable ${widget} card: "${title.slice(0, 300) || "a question"}"`,
      labels.length > 0 ? ` Choices: ${labels.join(" | ")}.` : "",
      picked ? ` They picked: ${picked}.` : widget === "question" ? " Not answered yet." : "",
      ")",
    ].join("");
  }
  if (widget === "chart") {
    // The numbers are kept so the agent can still talk about what it showed.
    const chart = chartData(props);
    const rows = (chart?.series ?? []).map(
      (entry) => `${entry.name ? `${entry.name}: ` : ""}${chart!.labels.map((label, index) => `${label} ${entry.values[index]}`).join(", ")}`,
    );
    return `(Shown to the person as a ${chart?.type ?? "bar"} chart${title ? `: "${title.slice(0, 200)}"` : ""}${rows.length > 0 ? `. ${rows.join("; ").slice(0, 600)}` : ""})`;
  }
  return `(Shown to the person as a ${widget} card${title ? `: "${title.slice(0, 200)}"` : ""})`;
}

/**
 * Converts rich blocks to plain text for summaries, FTS, and legacy clients.
 * Why: body stays the searchable/compatible column; payload is the rich source.
 * Materialized attachments render as Linux paths so the agent opens/copies
 * the file on its computer instead of re-emitting base64 through tools.
 * Input: validated MessageBlock array. Output: joined markdown/code/text fallback.
 */
export function blocksToText(blocks: MessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") parts.push(block.markdown);
    else if (block.kind === "code") parts.push(block.code);
    else if (block.kind === "image") {
      const at = "savedPath" in block && block.savedPath ? ` (saved at ${block.savedPath})` : "";
      parts.push(block.alt ? `[image: ${block.alt}${at}]` : `[image${at}]`);
    } else if (block.kind === "file") {
      const at = "savedPath" in block && block.savedPath ? ` (saved at ${block.savedPath})` : "";
      parts.push(`[file: ${block.name}${at}]`);
    } else if (block.kind === "widget") parts.push(widgetAsText(block.widget, block.props));
  }
  return parts.join("\n\n").slice(0, 100_000) || "[attachment]";
}

/**
 * Validates an image block URL.
 * Why: data URIs can blow up rows and prompts; remote URLs can leak SSRF via fetchers.
 * Input: raw url string. Output: true when https URL or small data:image URI.
 */
export function isSafeImageUrl(url: string): boolean {
  if (url.startsWith("data:image/")) {
    return url.length <= 8_000_000 && url.includes(";base64,");
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Saves one send_message emission in its own short transaction.
 * Why: Phase 11 removed the whole-turn transaction, so each bubble commits
 * alone — a later tool failure or a kill -9 keeps every earlier bubble. Tool
 * call order still matches insert order because executes run sequentially.
 * Input: store, ids, run id, validated blocks, optional replyTo/attribution, timestamp.
 * Output: the saved message row. Throws on cross-account replyTo or bad image.
 */
/**
 * Turns a "code" block that holds a plain sentence back into text.
 * Why: models sometimes put a status line in a code block, and the person saw
 * "Full sweep running…" in a monospace box. Real code (several lines, a language,
 * or code punctuation) stays a code block.
 */
export function proseCodeAsText(block: MessageBlock): MessageBlock {
  if (block.kind !== "code" || block.language) return block;
  const code = block.code.trim();
  if (code.includes("\n") || /[{}();=<>$`\[\]|\\]|=>|::|\/\//.test(code)) return block;
  // A sentence: five or more words, and sentence punctuation (a final stop, a dash, a comma).
  const words = code.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
  if (words < 5 || !/([.!?…]$|\s[—–-]\s|,\s)/u.test(code)) return block;
  return { kind: "text", markdown: code };
}

export async function saveSendMessage(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    runId?: string | null;
    blocks: MessageBlock[];
    replyTo?: string | null;
    viaAgentId?: string | null;
    createdAt: Date;
  },
) {
  const parsed = sendMessageInputSchema.parse({ blocks: input.blocks, replyTo: input.replyTo ?? null });
  parsed.blocks = parsed.blocks.map(proseCodeAsText);
  for (const block of parsed.blocks) {
    if (block.kind === "image" && !isSafeImageUrl(block.url)) {
      throw new Error("Image must be an https URL or a data:image base64 URI.");
    }
  }
  if (parsed.replyTo) {
    const [parent] = await store
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, parsed.replyTo),
          eq(messages.conversationId, input.conversationId),
          eq(messages.accountId, input.accountId),
        ),
      );
    if (!parent) throw new Error("replyTo message is not in this room.");
  }
  const body = blocksToText(parsed.blocks);
  const [saved] = await store
    .insert(messages)
    .values({
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      body,
      kind: "rich",
      payload: parsed.blocks,
      replyTo: parsed.replyTo ?? null,
      viaAgentId: input.viaAgentId ?? null,
      createdAt: input.createdAt,
    })
    .returning();
  if (!saved) throw new Error("send_message insert returned no row.");
  await mirrorGroupSpeechToOwnerDm(store, saved);
  return saved;
}

/**
 * When someone is @mentioned in a group, drops a "Message from X" badge into
 * the mentioned agent's private chat (the full bubble stays in the group).
 * Why: the person talks to each agent in its private chat. A mention is the
 * one group event that concerns that agent directly, so that is what shows up
 * there. Mirroring every group line buried the private chat in noise.
 * Input: store and the group message row. Output: nothing. Failures are
 * swallowed so a missing private chat never drops the group message.
 */
export async function mirrorGroupSpeechToOwnerDm(
  store: Store,
  message: typeof messages.$inferSelect,
): Promise<void> {
  try {
    if (!message.agentId || message.relayKind) return;
    const [room] = await store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, message.conversationId), eq(conversations.accountId, message.accountId)));
    if (!room || room.kind !== "group") return;
    const roster = await store
      .select({ id: agents.id, name: agents.name, label: agents.label })
      .from(members)
      .innerJoin(agents, eq(members.agentId, agents.id))
      .where(and(eq(members.conversationId, message.conversationId), eq(members.accountId, message.accountId)));
    const mentioned = mentionedIds(message.body, roster).filter((id) => id !== message.agentId);
    for (const agentId of mentioned) {
      const [dm] = await store
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, message.accountId),
            eq(conversations.kind, "direct"),
            eq(conversations.ownerAgentId, agentId),
          ),
        )
        .orderBy(asc(conversations.createdAt))
        .limit(1);
      if (!dm) continue;
      const [already] = await store
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, dm.id),
            eq(messages.sourceConversationId, message.conversationId),
            eq(messages.agentId, message.agentId),
            eq(messages.body, message.body),
          ),
        )
        .limit(1);
      if (already) continue;
      const [copy] = await store
        .insert(messages)
        .values({
          accountId: message.accountId,
          conversationId: dm.id,
          agentId: message.agentId,
          runId: message.runId,
          viaAgentId: null,
          body: message.body,
          kind: message.kind,
          payload: message.payload,
          replyTo: null,
          sourceConversationId: message.conversationId,
          relayKind: "from",
          relayPeers: [] as RelayPeer[],
          createdAt: message.createdAt,
        })
        .returning();
      if (!copy) continue;
      const event = { type: "message" as const, message: copy };
      try {
        const row = await appendEvent(store, {
          accountId: message.accountId,
          conversationId: dm.id,
          runId: message.runId,
          event,
        });
        publish(message.accountId, dm.id, { ...event, cursor: row.id });
      } catch {
        publish(message.accountId, dm.id, event);
      }
    }
  } catch {
    // The group bubble already committed; a mirror miss must not fail the send.
  }
}

/**
 * Saves one emoji tapback in its own short transaction.
 * Why: reactions are lightweight acknowledgements that must not create message
 * noise; unique per (message, user, emoji) so retries are idempotent.
 * Input: store, account/conversation/agent ids, messageId, emoji.
 * Output: { reaction, created } so HTTP can wake the agent only on first tap.
 */
export async function saveReaction(
  store: Store,
  input: { accountId: string; conversationId: string; agentId: string | null; messageId: string; emoji: string },
): Promise<{ reaction: typeof reactions.$inferSelect; created: boolean }> {
  const parsed = reactionSchema.parse({ messageId: input.messageId, emoji: input.emoji });
  const [parent] = await store
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, parsed.messageId),
        eq(messages.conversationId, input.conversationId),
        eq(messages.accountId, input.accountId),
      ),
    );
  if (!parent) throw new Error("Reaction target is not in this room.");
  const userKey = input.agentId ?? "owner";
  const [existing] = await store
    .select()
    .from(reactions)
    .where(and(eq(reactions.messageId, parsed.messageId), eq(reactions.userKey, userKey), eq(reactions.emoji, parsed.emoji)));
  if (existing) return { reaction: existing, created: false };
  const [saved] = await store
    .insert(reactions)
    .values({
      accountId: input.accountId,
      messageId: parsed.messageId,
      agentId: input.agentId,
      userKey,
      emoji: parsed.emoji,
    })
    .returning();
  if (!saved) throw new Error("Reaction insert returned no row.");
  return { reaction: saved, created: true };
}
