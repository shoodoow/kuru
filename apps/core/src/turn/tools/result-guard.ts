/**
 * Rules that keep a worker from flooding or re-reading its own context.
 * Why: one `cat` or MCP listing could put up to 1 MB into the conversation, and
 * every later step resent it. And a worker that lost track read the same send
 * log and shortlist 5-8 times and paged the same Resend history 27 times in one
 * 127-step run. A big result is cut once, when it arrives (never again later, so
 * the provider's cache keeps matching), with the full text saved to a file; a
 * source read again and again is answered with a note instead.
 * DB: none.
 */
import { isReadOnlyShell } from "../../rooms/worker-loop.js";

/** Longest result kept whole in the conversation, in characters (~10,000 tokens). */
export const RESULT_INLINE_CHARS = 40_000;
const HEAD_CHARS = 30_000;
const TAIL_CHARS = 6_000;
/** The read that gets a reminder, and the read that is no longer run. */
export const REREAD_WARN_AT = 3;
export const REREAD_REFUSE_AT = 5;

/** Input keys that say why a call was made or how to phrase it, not what it reads. */
const NOT_THE_SOURCE = new Set(["context", "llm_model", "reason", "why", "note"]);
const LISTING = /(^|[_-])(list|search|get|find|query|fetch)([_-]|$)/i;
const FILE_COMMANDS = new Set(["cat", "head", "tail", "sed", "less", "more", "nl", "wc", "awk", "grep", "jq"]);

/**
 * The sources one call reads, as stable keys; empty for calls that change things.
 * Input: tool name and input. Output: keys such as `file:/home/u/notes.md`.
 */
export function sourceKeys(name: string, input: Record<string, unknown>): string[] {
  if (name === "read" && typeof input.path === "string") return [`file:${normalizePath(input.path)}`];
  if (name === "web_fetch" && typeof input.url === "string") return [`url:${input.url}`];
  if (name === "bash" && typeof input.command === "string") {
    if (!isReadOnlyShell(input.command)) return [];
    return filesInCommand(input.command).map((path) => `file:${path}`);
  }
  if (LISTING.test(name)) {
    const kept = Object.entries(input)
      .filter(([key]) => !NOT_THE_SOURCE.has(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return [`call:${name}:${JSON.stringify(kept)}`];
  }
  return [];
}

function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Files a read-only shell command prints from: arguments of cat/head/sed and the like that look like paths. */
function filesInCommand(command: string): string[] {
  const found = new Set<string>();
  const cd = /(?:^|&&|;)\s*cd\s+([^\s;&|]+)/.exec(command)?.[1]?.replace(/^['"]|['"]$/g, "");
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/);
    if (!FILE_COMMANDS.has(words[0] ?? "")) continue;
    for (const word of words.slice(1)) {
      const clean = word.replace(/^['"]|['"]$/g, "");
      if (clean.startsWith("-") || /[*?$`{}<>]/.test(clean)) continue;
      if (!/\.[a-z0-9]{1,5}$/i.test(clean) && !clean.includes("/")) continue;
      if (/^\d+(,\d+)?p$/.test(clean)) continue;
      const absolute = clean.startsWith("/") || clean.startsWith("~") || !cd ? clean : `${cd}/${clean}`;
      found.add(normalizePath(absolute));
    }
  }
  return [...found];
}

/**
 * Counts reads of each source over one run.
 * Output of `record`: what to do with this call.
 */
export class ReadCounter {
  private readonly counts = new Map<string, number>();

  record(keys: string[]): { action: "run" } | { action: "remind" | "refuse"; source: string; times: number } {
    let worst: { source: string; times: number } | null = null;
    for (const key of keys) {
      const times = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, times);
      if (!worst || times > worst.times) worst = { source: key.replace(/^(file|url|call):/, ""), times };
    }
    if (!worst || worst.times < REREAD_WARN_AT) return { action: "run" };
    return { action: worst.times >= REREAD_REFUSE_AT ? "refuse" : "remind", ...worst };
  }

  /** A file the worker just changed may be read again freely. */
  changed(paths: string[]): void {
    for (const path of paths) this.counts.delete(`file:${normalizePath(path)}`);
  }
}

/**
 * Files one call writes: the path of write/edit, and redirect targets of a shell command.
 * Input: tool name and input. Output: paths, possibly relative.
 */
export function writtenPaths(name: string, input: Record<string, unknown>): string[] {
  if ((name === "write" || name === "edit") && typeof input.path === "string") return [input.path];
  if (name !== "bash" || typeof input.command !== "string") return [];
  const out: string[] = [];
  for (const match of input.command.matchAll(/>>?\s*['"]?([^\s'";|&>]+)/g)) {
    if (match[1] && match[1] !== "/dev/null" && !/^&?\d$/.test(match[1])) out.push(match[1]);
  }
  for (const match of input.command.matchAll(/\b(?:sed\s+-i\S*|tee(?:\s+-a)?)\s+(?:'[^']*'\s+|"[^"]*"\s+)?([^\s'";|&]+)/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Keys under which a tool result carries a picture's bytes. */
const PICTURE_KEYS = ["jpegBase64", "pngBase64", "base64", "data", "image"];

/**
 * The text of a tool result, when it is text or plain data; null for pictures and other shapes.
 * Why null for pictures: a screenshot is {path, jpegBase64}. Cut as text it reached
 * the model as 36,000 characters of image bytes (about 23,000 tokens) instead of a picture.
 */
export function resultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const shaped = result as Record<string, unknown>;
    if (shaped.type === "image" || Array.isArray(shaped.content)) return null;
    if (PICTURE_KEYS.some((key) => typeof shaped[key] === "string" && (shaped[key] as string).length > 1_000)) return null;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

/**
 * A big result as it stays in the conversation: its start and end, and where the whole text is.
 * Input: the full text and the path it was saved to (null when saving failed).
 */
export function cutResult(text: string, savedAt: string | null): string {
  const left = text.length - HEAD_CHARS - TAIL_CHARS;
  const where = savedAt
    ? `The whole output (${text.length} characters) is saved at ${savedAt}; read the part you need with grep -n or sed -n instead of running this again.`
    : `The whole output was ${text.length} characters; narrow the command or send its output to a file and read part of it.`;
  return `${text.slice(0, HEAD_CHARS)}\n\n[... ${left} characters not shown. ${where} ...]\n\n${text.slice(-TAIL_CHARS)}`;
}
