import type { MessageBlock } from "@kuru/shared";
import { exec, execBytes, execStdin } from "../linux/linux.js";

// Why: phone attachments arrive as data: URIs. Stuffing megabytes of base64
// into the prompt (and forcing the model to re-emit them through a write
// tool) is slow, expensive, and lossy. Landing each file on the account Linux
// first lets the agent work with paths — cp/mv/open — on the account Linux.
// /shared/uploads is the handoff dir: every agent on
// the account can read it, and message ids keep each send isolated.
export const UPLOADS_ROOT = "/shared/uploads";
const MAX_FILES_PER_MESSAGE = 5;
const MAX_TOTAL_BYTES = 10_000_000;
const MAX_PREVIEW_CHARS = 700_000;
/** Files up to this size travel inside the message; larger ones are streamed from the computer. */
const MAX_OUTBOUND_FILE_BYTES = 5_000_000;
const MAX_REMOTE_FILE_BYTES = 2_000_000_000;
/** What a streamed file's url holds in the stored message; the phone never sees it. */
export const REMOTE_URL = "computer:";

/**
 * Sanitizes an attachment filename for shell-safe writes.
 * Why: names come from the phone and end up inside sh -c; path traversal or
 * metacharacters must be impossible by construction. Pure for testing.
 * Input: raw name. Output: safe basename (fallback "file").
 */
export function sanitizeFileName(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean.length > 0 ? clean : "file";
}

/**
 * Splits a data: URI into mime + base64 payload.
 * Why: pure parse step so validation stays unit-testable without Docker.
 * Input: any url string. Output: {mime, base64} or null when not a data URI.
 */
export function parseDataUri(url: string): { mime: string; base64: string } | null {
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) return null;
  return { mime: match[1]!, base64: match[2]! };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Guesses a mime type from a file name so the phone can open the attachment. */
export function mimeForName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** The Linux user that owns a home directory such as /home/uabc123. */
function profileOfHome(home?: string): string | undefined {
  return home?.startsWith("/home/") ? home.slice("/home/".length).split("/")[0] || undefined : undefined;
}

/** True when a file block's url is a path on the account computer the agent may send. */
function isComputerPath(url: string, home?: string): boolean {
  return url.startsWith("/shared/") || (Boolean(home) && url.startsWith(`${home}/`));
}

/**
 * Converts files on the account computer into real attachment bytes.
 * Why: a path inside the computer is not a URL the phone can open. The agent
 * may send from /shared or from its own home (where its work lives). A small
 * file is stored as a data URI. A large one (a finished video, an archive) is
 * stored as a reference and streamed from the computer when the phone asks,
 * so it arrives exactly as the agent made it.
 * Input: account id, blocks, and the sending agent's home directory.
 */
export async function inlineSharedOutputBlocks(
  accountId: string,
  blocks: MessageBlock[],
  home?: string,
): Promise<MessageBlock[]> {
  const out: MessageBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "file" || !isComputerPath(block.url, home)) {
      out.push(block);
      continue;
    }
    if (block.url.includes("\0") || block.url.split("/").includes("..")) {
      throw new Error("Attachment path is invalid.");
    }
    // Everything runs as the sending agent, so a link pointing into someone
    // else's home is refused by Linux.
    const user = profileOfHome(home) ?? "root";
    const mime = block.mime || mimeForName(block.name || block.url);
    const size = await fileSize(accountId, block.url, user);
    if (size === null) throw new Error(`Could not read attachment ${block.url}. Check the path exists.`);
    if (size > MAX_REMOTE_FILE_BYTES) {
      throw new Error(`Attachment ${block.name} is larger than 2 GB. Send a smaller export.`);
    }
    if (size > MAX_OUTBOUND_FILE_BYTES) {
      // Too large to hold in the message. The file stays where it is, untouched,
      // and the phone streams it from there (see the /file route).
      out.push({ ...block, mime, url: `${REMOTE_URL}${block.url}`, savedPath: block.url, remote: true, size });
      continue;
    }
    const bytes = await execBytes(accountId, ["cat", "--", block.url], user, undefined, {
      maxBytes: MAX_OUTBOUND_FILE_BYTES + 1,
    });
    if (bytes.code !== 0 || bytes.truncated) throw new Error(`Could not read attachment ${block.url}. Check the path exists.`);
    out.push({
      ...block,
      mime,
      url: `data:${mime};base64,${bytes.stdout.toString("base64")}`,
      savedPath: block.savedPath ?? block.url,
    });
  }
  return out;
}

/**
 * The size of a file on the account computer, as one of its users.
 * Output: bytes, or null when that user cannot read it or it is not a regular file.
 */
export async function fileSize(accountId: string, path: string, user: string): Promise<number | null> {
  if (path.includes("\0") || path.split("/").includes("..")) return null;
  const result = await exec(accountId, ["sh", "-c", '[ -f "$1" ] && [ -r "$1" ] && stat -c %s -- "$1"', "size", path], user);
  const size = Number(result.stdout.trim());
  return result.code === 0 && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

const FILE_PLACEHOLDER = /\[file:\s*([^\]\n]*?)\s*\(saved at\s+(\/[^)\n]+?)\)\s*\]/g;

/**
 * Pulls "[file: name (saved at /path)]" placeholders out of reply text.
 * Why: history shows sent files in that form, so models copy it into plain
 * text instead of attaching the file, and the person gets a line of text
 * where the file should be. Turning it back into a file block delivers it.
 * Input: reply text. Output: the text without placeholders, plus file blocks.
 */
export function fileBlocksFromText(text: string): { text: string; files: { url: string; name: string }[] } {
  const files: { url: string; name: string }[] = [];
  const rest = text.replace(FILE_PLACEHOLDER, (_match, name: string, path: string) => {
    const url = path.trim();
    if (!files.some((file) => file.url === url)) {
      files.push({ url, name: name.trim() || url.split("/").pop() || "file" });
    }
    return "";
  });
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), files };
}

/**
 * Materializes data: attachment blocks onto the account Linux.
 * Why: one exec per file via stdin (no ARG_MAX ceiling), per-file degrade to
 * passthrough so one bad file never sinks the message, images additionally
 * get a downscaled preview data URI for cheap vision grounding while the
 * full file stays on disk for the agent to open.
 * Input: account id, owning message id, validated blocks.
 * Output: blocks with savedPath (+previewUrl for images) where materialized.
 */
export async function materializeBlocks(
  accountId: string,
  messageId: string,
  blocks: MessageBlock[],
): Promise<MessageBlock[]> {
  const dir = `${UPLOADS_ROOT}/${messageId}`;
  let files = 0;
  let totalBytes = 0;
  const out: MessageBlock[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "image" && block.kind !== "file") {
      out.push(block);
      continue;
    }
    const parsed = parseDataUri(block.url);
    if (!parsed || files >= MAX_FILES_PER_MESSAGE) {
      out.push(block);
      continue;
    }
    const bytes = Math.floor((parsed.base64.length * 3) / 4);
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      out.push(block);
      continue;
    }
    try {
      const fallbackName = block.kind === "image" ? `image-${index}.jpg` : `file-${index}`;
      const name = sanitizeFileName(block.kind === "image" ? block.alt ?? fallbackName : block.name);
      const path = `${dir}/${name}`;
      const written = await execStdin(
        accountId,
        ["sh", "-c", `mkdir -p ${dir} && base64 -d > ${path} && chmod 644 ${path}`],
        Buffer.from(parsed.base64, "utf8"),
      );
      if (written.code !== 0) {
        out.push(block);
        continue;
      }
      files += 1;
      totalBytes += bytes;
      if (block.kind === "image") {
        const previewUrl = await previewImage(accountId, path);
        out.push({ ...block, savedPath: path, ...(previewUrl ? { previewUrl } : {}) });
      } else {
        out.push({ ...block, savedPath: path });
      }
    } catch {
      out.push(block);
    }
  }
  return out;
}

/**
 * Builds a downscaled preview of a saved image for vision input.
 * Why: a 5MB phone photo costs ~1.5k tokens per million… actually ~765 tokens
 * per 1k px at detail-high; a 1568px preview keeps grounding accurate while
 * the prompt stays small. Returns null (agent still has the full file) when
 * ImageMagick is missing or the preview stays oversized.
 * Input: account id + saved image path. Output: data: JPEG URI or null.
 */
async function previewImage(accountId: string, path: string): Promise<string | null> {
  try {
    const resized = await execBytes(accountId, [
      "sh",
      "-c",
      `convert ${path} -resize 1568x1568\\> -quality 70 jpg:- | base64 -w0`,
    ]);
    if (resized.code !== 0) return null;
    const base64 = resized.stdout.toString("utf8").trim();
    if (base64.length === 0 || base64.length > MAX_PREVIEW_CHARS) return null;
    return `data:image/jpeg;base64,${base64}`;
  } catch {
    return null;
  }
}
