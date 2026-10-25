/**
 * Coerces common model mistakes into send_message input before Zod parse.
 * Why: providers sometimes flatten blocks, stringify the array, or dump a
 * `[widget:secret {…}]` line as markdown instead of a real widget block.
 */
import { expandWidgetMarkupBlocks } from "@kuru/shared";

/**
 * Output: the blocks to send, the reply target, and how many approval cards the model
 * copied were dropped. Why drop them: the system already posts the card when it asks for
 * approval. The Chief of Staff resent that card through send_message with the same
 * approvalId, and the person saw one approval twice.
 */
export function normalizeSendMessageInput(input: Record<string, unknown>): { blocks: unknown; replyTo?: unknown; droppedApprovalCards: number } {
  let blocks = input.blocks;
  let droppedApprovalCards = 0;
  let replyTo = input.replyTo;

  if (blocks === undefined && typeof input.kind === "string") {
    const { replyTo: rt, kind, ...rest } = input;
    blocks = [{ kind, ...rest }];
    if (replyTo === undefined && rt !== undefined) replyTo = rt;
  }

  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks) as unknown;
    } catch {
      blocks = [{ kind: "text", markdown: blocks }];
    }
  }

  if (blocks !== null && typeof blocks === "object" && !Array.isArray(blocks)) {
    const obj = blocks as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      blocks = [obj];
    }
  }

  if (Array.isArray(blocks)) {
    blocks = expandWidgetMarkupBlocks(blocks).map((block) => {
      if (!block || typeof block !== "object") return block;
      const row = block as { kind?: string; markdown?: string; widget?: string; props?: Record<string, unknown> };
      if (row.kind === "text" && typeof row.markdown === "string") {
        return { ...row, markdown: stripInternalChatMarks(row.markdown) };
      }
      if (row.kind === "file" || ((row.kind === "image" || row.kind === undefined) && localPathOf(block as Record<string, unknown>))) {
        return fileBlockFrom(block as Record<string, unknown>);
      }
      if (
        row.kind === "widget" &&
        row.widget === "approval" &&
        (!row.props?.approvalId || typeof row.props.approvalId !== "string")
      ) {
        const title = typeof row.props?.title === "string" ? row.props.title : "Approval needed";
        const detail =
          typeof row.props?.detail === "string"
            ? row.props.detail
            : typeof row.props?.body === "string"
              ? row.props.body
              : "";
        return { kind: "text", markdown: detail ? `**${title}**\n${detail}` : `**${title}**` };
      }
      if (row.kind === "widget" && row.widget === "approval") {
        droppedApprovalCards += 1;
        return null;
      }
      return block;
    });
    blocks = dropRepeatedQuestion((blocks as unknown[]).filter((block) => block !== null));
  }

  return { blocks, replyTo: replyTo ?? null, droppedApprovalCards };
}

/** Keys a model uses for a file's location instead of `url`. */
const PATH_KEYS = ["url", "path", "file", "filePath", "src", "href", "savedPath"] as const;

/** The file location a block names, as a plain path: `file://` and `computer:` prefixes removed. */
function locationOf(row: Record<string, unknown>): string {
  for (const key of PATH_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/^computer:/, "").replace(/^file:\/\/(?=[^/])/, "/").replace(/^file:\/\//, "");
  }
  return "";
}

/** A path on the agent's computer named by an image or untyped block, or "" when it names none. */
function localPathOf(row: Record<string, unknown>): string {
  const location = locationOf(row);
  return location.startsWith("/") || location.startsWith("~/") ? location : "";
}

/**
 * Puts a file block into the one shape the server accepts: `url` and `name`.
 * Why: a model sent `path` for `url`, left out `name`, or wrote
 * `file://home/...`; each was refused as a whole message, and after ten
 * tries the person had ten bubbles of file names and no video.
 * Input: a block the model sent as a file. Output: `{ kind: "file", url, name }`.
 */
function fileBlockFrom(row: Record<string, unknown>): Record<string, unknown> {
  const url = locationOf(row);
  const given = typeof row.name === "string" && row.name.trim() ? row.name.trim() : typeof row.alt === "string" && row.alt.trim() ? row.alt.trim() : "";
  const name = given || url.split("/").filter(Boolean).pop() || "file";
  return { kind: "file", url, name, ...(typeof row.mime === "string" ? { mime: row.mime } : {}) };
}

/**
 * Removes a question from the text that the card right after it asks again.
 * Why: models write "Got it. What kind of work do you do?" and then send a
 * question card with the same prompt, so the person reads the question twice.
 * Input: the blocks. Output: the blocks, with the repeated sentence cut from
 * the text (and the text block dropped when nothing else was in it).
 */
export function dropRepeatedQuestion(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  blocks.forEach((block, index) => {
    const row = block as { kind?: string; markdown?: unknown } | null;
    const next = blocks[index + 1] as { kind?: string; widget?: string; props?: { prompt?: unknown } } | null | undefined;
    const prompt = next?.kind === "widget" && next.widget === "question" && typeof next.props?.prompt === "string" ? next.props.prompt.trim() : "";
    if (!row || row.kind !== "text" || typeof row.markdown !== "string" || prompt.length < 8) {
      out.push(block);
      return;
    }
    const text = row.markdown.trimEnd();
    if (!text.toLowerCase().endsWith(prompt.toLowerCase())) {
      out.push(block);
      return;
    }
    const kept = text.slice(0, text.length - prompt.length).trimEnd();
    if (kept) out.push({ ...row, markdown: kept });
  });
  return out;
}

/** Drops message-id citations and worker report labels the person should not see. */
export function stripInternalChatMarks(markdown: string): string {
  return markdown
    .replace(/^\s*\[msg:[^\]]+\]\s*/i, "")
    .replace(/\n\s*\[msg:[^\]]+\]\s*/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*\*{0,2}(Findings|What I did|Blockers)\*{0,2}\s*:\s*/i, ""))
    .join("\n")
    .trim();
}
