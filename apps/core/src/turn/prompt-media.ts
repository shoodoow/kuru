/**
 * Vision and text extraction for model messages.
 * Why: keeps image/file part rules out of orchestration. DB: reads message payload shape only.
 */
import { parseDataUri } from "../rooms/uploads.js";
import { MAX_VISION_CHARS, MAX_VISION_IMAGES } from "./constants.js";
import { historyBody, tailSlice } from "./util.js";

export type TurnImagePart =
  | { type: "file"; data: string; mediaType: string }
  | { type: "image"; image: string };

export type TurnMessageContent = string | Array<{ type: "text"; text: string } | TurnImagePart>;

export type HistoryRow = {
  id?: string;
  createdAt?: Date;
  agentId: string | null;
  body: string;
  payload: unknown;
  replyTo?: string | null;
  relayKind?: string | null;
};

export type ReplyParent = {
  body: string;
  agentId: string | null;
};

export function textOf(content: TurnMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

export function toImagePart(ref: string): TurnImagePart | null {
  if (ref.startsWith("data:")) {
    const parsed = parseDataUri(ref);
    if (!parsed) return null;
    return { type: "file", data: parsed.base64, mediaType: parsed.mime };
  }
  try {
    const parsed = new URL(ref);
    if (parsed.protocol !== "https:") return null;
    return { type: "image", image: ref };
  } catch {
    return null;
  }
}

/**
 * Prefixes a reply with who/what it answers so the model sees the thread link.
 * Why: replyTo is stored on the row but the body alone ("yes" / "b") has no parent.
 */
export function formatReplyBody(body: string, parent: ReplyParent | null | undefined): string {
  if (!parent) {
    return body.includes("(Replying to") ? body : `(Replying to an earlier message)\n${body}`;
  }
  const who = parent.agentId ? "you" : "them";
  const quote = parent.body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `(Replying to ${who}: "${quote}")\n${body}`;
}

/** A pause this long between two messages gets a date line, so the model sees time passing. */
const DATE_MARKER_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Date line for a message that follows a long pause (or opens the window).
 * Why: a years-long thread reads as one continuous chat unless the dates are
 * visible; "last week" and "yesterday" only make sense against them.
 * Input: previous and current message times, the person's timezone.
 * Output: a bracketed date, or null when no marker is due.
 */
export function dateMarker(previous: Date | undefined, current: Date | undefined, timezone?: string): string | null {
  if (!current) return null;
  if (previous && current.getTime() - previous.getTime() < DATE_MARKER_GAP_MS) return null;
  try {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone?.trim() || "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(current);
    return `[${day}]`;
  } catch {
    return `[${current.toISOString().slice(0, 10)}]`;
  }
}

/**
 * Builds model chat messages from recent history, with images and reply context.
 * Input: history rows (+ optional parent map for replyTo outside the window).
 * Output: role/content pairs for the model.
 */
/** Notes the person's reactions to agent messages since their previous message. */
function reactionNote(history: HistoryRow[], index: number, reactions?: Map<string, string[]>): string {
  if (!reactions || reactions.size === 0) return "";
  const notes: string[] = [];
  for (let at = index - 1; at >= 0 && history[at]!.agentId; at -= 1) {
    const row = history[at]!;
    const emojis = row.id ? reactions.get(row.id) : undefined;
    if (!emojis || emojis.length === 0) continue;
    const snippet = row.body.replace(/\s+/g, " ").trim().slice(0, 80);
    notes.unshift(`[they reacted ${emojis.join(" ")} to your message "${snippet}"]`);
  }
  return notes.join("\n");
}

export function toModelMessages(
  history: HistoryRow[],
  parents?: Map<string, ReplyParent>,
  timezone?: string,
  /** The person's emoji reactions, by the id of the message they reacted to. */
  reactions?: Map<string, string[]>,
  /** Who is reading. Other agents' messages are shown as theirs, by name. */
  reader?: { selfId: string; names: Map<string, string> },
): { role: "user" | "assistant"; content: TurnMessageContent }[] {
  const byId = new Map<string, ReplyParent>();
  for (const row of history) {
    if (row.id) byId.set(row.id, { body: row.body, agentId: row.agentId });
  }
  if (parents) {
    for (const [id, parent] of parents) byId.set(id, parent);
  }

  const wanted = new Map<number, TurnImagePart[]>();
  let remaining = MAX_VISION_IMAGES;
  for (let index = history.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = history[index]!;
    if (row.agentId || !Array.isArray(row.payload)) continue;
    for (const block of row.payload) {
      if (remaining === 0) break;
      if (typeof block !== "object" || block === null || (block as { kind?: string }).kind !== "image") continue;
      const image = block as { url?: string; previewUrl?: string };
      const ref = typeof image.previewUrl === "string" && image.previewUrl.length > 0 ? image.previewUrl : image.url;
      if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_VISION_CHARS) continue;
      const part = toImagePart(ref);
      if (!part) continue;
      const list = wanted.get(index) ?? [];
      list.unshift(part);
      wanted.set(index, list);
      remaining -= 1;
    }
  }
  return history.map((row, index) => {
    // In a group, a teammate's message is something said to this agent, not
    // by it. Sent as its own words, the model answered itself or stayed quiet.
    const other = Boolean(reader && row.agentId && row.agentId !== reader.selfId);
    const role = row.agentId && !other ? "assistant" : "user";
    const where = row.relayKind ? ", passed on to you" : "";
    const speaker = other ? `[${reader!.names.get(row.agentId!) ?? "teammate"}${where}]: ` : "";
    const body = `${speaker}${historyBody(row.body, !row.agentId)}`;
    const linked = row.replyTo ? formatReplyBody(body, byId.get(row.replyTo) ?? null) : body;
    const marker = dateMarker(history[index - 1]?.createdAt, row.createdAt, timezone);
    // A reaction is feedback on what the agent said. It rides on the person's
    // next message, so the agent sees it even when the tap did not wake it.
    const reacted = role === "user" && !other ? reactionNote(history, index, reactions) : "";
    const text = [marker, reacted, linked].filter(Boolean).join("\n");
    const parts = wanted.get(index);
    // Only marked here: `replaySentCards` expands it once work logs are woven in.
    const sentCard = reader ? sentCardOf(row, role === "assistant") : null;
    if (sentCard) return { role, content: text, sentCard } as { role: "user" | "assistant"; content: TurnMessageContent };
    // A card the app posted for the agent (a link to a new agent's chat, an
    // approval) is not something the agent wrote; shown as its own words it
    // would be copied as text.
    if (reader && role === "assistant" && isAppCard(row.payload)) return { role: "user", content: `[app note] ${text}` };
    if (!parts || parts.length === 0) return { role, content: text };
    return {
      role,
      content: [{ type: "text", text }, ...parts],
    } as { role: "user" | "assistant"; content: TurnMessageContent };
  });
}

/** A model message that may carry a card this agent sent, to be replayed as the tool call it was. */
type WithSentCard<T> = T & { sentCard?: { id: string; blocks: unknown[]; answer: string | null } };

/** The widgets an agent sends itself with send_message and that the person answers. */
const REPLAYED_WIDGETS = new Set(["question", "poll"]);

/**
 * Finds the card in one of the agent's own messages.
 * Input: a history row and whether the reader wrote it. Output: the blocks as
 * they were sent (without the person's answer) plus that answer, or null.
 */
export function sentCardOf(row: HistoryRow, own: boolean): { id: string; blocks: unknown[]; answer: string | null } | null {
  if (!own || !row.id || !Array.isArray(row.payload)) return null;
  let answer: string | null = null;
  let found = false;
  const blocks: unknown[] = [];
  for (const block of row.payload as { kind?: string; widget?: string; markdown?: unknown; props?: Record<string, unknown> }[]) {
    if (block?.kind === "text" && typeof block.markdown === "string") blocks.push({ kind: "text", markdown: block.markdown });
    else if (block?.kind === "widget" && typeof block.widget === "string" && REPLAYED_WIDGETS.has(block.widget)) {
      const { selected, ...props } = block.props ?? {};
      if (typeof selected === "string" && selected.trim()) answer = selected.trim();
      blocks.push({ kind: "widget", widget: block.widget, props });
      found = true;
    }
  }
  return found ? { id: row.id, blocks, answer } : null;
}

/**
 * Replays the agent's own cards as the `send_message` calls they were.
 * Why: a card shown back as text, in any wording, teaches the model that
 * writing that text is how a card is made, and it stops calling the tool. A
 * real tool call with its result is the one form it cannot mistake for prose,
 * and the result is where the person's answer belongs.
 * Input: model messages, some marked by `toModelMessages` with `sentCard`.
 * Output: the same list, each marked message replaced by a tool call and its result.
 */
export function replaySentCards<T extends { role: string; content: unknown }>(messages: WithSentCard<T>[]): T[] {
  return messages.flatMap((message) => {
    const card = message.sentCard;
    if (!card) return [message as T];
    const toolCallId = `card_${card.id.replaceAll("-", "")}`;
    return [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: "send_message", input: { blocks: card.blocks } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "send_message",
            output: {
              type: "json",
              value: {
                messageId: card.id,
                shown: true,
                answer: card.answer,
                note: card.answer ? `The person answered: ${card.answer}` : "The person has not tapped an answer.",
              },
            },
          },
        ],
      },
    ] as unknown as T[];
  });
}

/** True when a message holds only cards the agent did not send itself. */
function isAppCard(payload: unknown): boolean {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  return payload.every(
    (block) =>
      (block as { kind?: string })?.kind === "widget" && !REPLAYED_WIDGETS.has(String((block as { widget?: unknown }).widget)),
  );
}

const PICTURE_NOTE = "[A picture was attached here, but your model cannot see pictures. If it matters, say so and ask what it shows.]";

/**
 * Replaces every picture in a chat prompt with a short note.
 * Why: a text-only model given a picture makes the provider refuse the whole turn.
 */
export function picturesAsNotes<T>(messages: T[]): T[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const next = content.map((part: { type?: string; mediaType?: string }) => {
      const picture = part?.type === "image" || (part?.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/"));
      if (!picture) return part;
      changed = true;
      return { type: "text", text: PICTURE_NOTE };
    });
    return changed ? ({ ...message, content: next } as T) : message;
  });
}
