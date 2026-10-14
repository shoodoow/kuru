/**
 * Pure rules for a worker's long-running loop.
 * Why: a worker used to get a fixed handful of steps and was cut off mid-job,
 * and every restart began blank. Now it runs until the job is done, so the
 * loop needs its own guard rails: notice a worker that only reads, keep the
 * conversation inside the model's window, and store it small enough to
 * continue later. DB: none (callers persist what these return).
 */
import type { ModelMessage } from "ai";

/** Safety ceiling, not a budget: far above what a real job needs, low enough to stop a runaway. */
export const WORKER_STEP_CEILING = 150;
/** Steps between housekeeping (save the conversation, deliver notes, trim old output). */
export const WORKER_SEGMENT_STEPS = 6;
/** Longest one run may take before it is told to wrap up and report. */
export const WORKER_WALL_MS = 90 * 60 * 1000;
/** Steps spent only looking before the worker is told to start doing. */
export const LOOK_ONLY_NUDGE_AFTER = 8;
/** Steps left when the worker is warned the ceiling is near. */
export const WRAP_UP_WARNING_STEPS = 8;
/** Largest conversation kept for a later continuation, as JSON characters. */
export const TRANSCRIPT_STORE_CHARS = 600_000;

const LOOK_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "read_skill",
  "list_skills",
  "read_history",
  "browser_snapshot",
  "browser_read",
  "browser_screenshot",
  "browser_list_pages",
  "computer_screenshot",
]);

const READ_ONLY_COMMANDS = new Set([
  "cat", "ls", "head", "tail", "grep", "egrep", "rg", "wc", "echo", "printf", "pwd", "which", "command", "type",
  "file", "stat", "tree", "du", "df", "ps", "env", "printenv", "test", "[", "true", "cd", "sort", "uniq", "cut",
  "tr", "jq", "ffprobe", "date", "id", "whoami", "uname", "nl", "less", "more", "basename", "dirname", "realpath",
  "readlink", "diff", "cmp", "md5sum", "sha256sum", "hostname", "nproc", "free", "fc-list", "fc-match", "xdpyinfo",
  "column", "strings", "xxd", "hexdump",
]);

/**
 * True when a shell command only inspects things and changes nothing.
 * Why: a worker stuck reading source files makes no progress however many
 * steps it gets. Conservative on purpose: anything unrecognised counts as doing.
 * Input: the command text. Output: whether every part of it only reads.
 */
export function isReadOnlyShell(command: string): boolean {
  const text = command.trim();
  if (!text) return true;
  // A redirect into a real file is a write. Discarding output or merging streams is not.
  const withoutHarmless = text.replace(/\d?>>?\s*\/dev\/null/g, "").replace(/\d?>&\d/g, "");
  if (/(^|[^<])>>?\s*[^\s&]/.test(withoutHarmless)) return false;
  if (/<<-?\s*['"]?\w+/.test(text) && !/^\s*(cat|node|python3?)\b/.test(text)) return false;
  // Quoted text is data, not commands: a `;` inside a one-liner must not split it.
  const unquoted = withoutHarmless.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "Q");
  const parts = unquoted
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    // Leading `NAME=value` assignments are setup for the command that follows.
    const words = part.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const head = words[0];
    if (!head) continue;
    if (head === "sed") {
      if (!words.includes("-n") || words.some((word) => /^-[a-z]*i/.test(word))) return false;
      continue;
    }
    if (head === "find") {
      if (words.some((word) => word === "-delete" || word === "-exec" || word === "-execdir")) return false;
      continue;
    }
    if (head === "awk") continue;
    if (head === "node" || head === "python3" || head === "python") {
      // One-liners that print parts of a file are reading; a script file may do anything.
      if (!words.some((word) => word === "-e" || word === "-c" || word === "-p" || word === "-")) return false;
      if (/writeFile|appendFile|mkdir|unlink|rmSync|open\([^)]*['"][wa]/.test(text)) return false;
      continue;
    }
    if (words.some((word) => word === "--help" || word === "-h" || word === "--version")) continue;
    // A tool's own documentation command (`npx <tool> docs <topic>`) only prints.
    if (head === "npx" && words.some((word) => word === "docs" || word === "help")) continue;
    if (!READ_ONLY_COMMANDS.has(head)) return false;
  }
  return true;
}

/**
 * True when one finished step only looked at things.
 * Input: the step's tool calls. Output: false for a step that wrote, ran, or clicked.
 */
export function isLookOnlyStep(calls: { name: string; input: unknown }[]): boolean {
  if (calls.length === 0) return false;
  return calls.every((call) => {
    if (LOOK_ONLY_TOOLS.has(call.name)) return true;
    if (call.name !== "bash") return false;
    const command = (call.input as { command?: unknown } | null)?.command;
    return typeof command === "string" && isReadOnlyShell(command);
  });
}

type Part = Record<string, unknown>;

function isImagePart(part: Part): boolean {
  const type = String(part.type ?? "");
  if (type === "image" || type === "media" || type === "image-data" || type === "file-data") return true;
  if (type === "file") return /^image\//.test(String(part.mediaType ?? part.mimeType ?? ""));
  return false;
}

const IMAGE_GONE = "[A picture was here. It is no longer in view; open the file again if you need to look at it.]";

/** Text of one tool output, with pictures replaced by a note. */
function outputText(output: unknown): { text: string; hadImage: boolean } {
  if (output == null) return { text: "", hadImage: false };
  if (typeof output === "string") return { text: output, hadImage: false };
  const shaped = output as { type?: unknown; value?: unknown };
  if (shaped.type === "text" || shaped.type === "error-text") {
    return { text: String(shaped.value ?? ""), hadImage: false };
  }
  if (shaped.type === "content" && Array.isArray(shaped.value)) {
    let hadImage = false;
    const text = (shaped.value as Part[])
      .map((part) => {
        if (isImagePart(part)) {
          hadImage = true;
          return IMAGE_GONE;
        }
        return typeof part.text === "string" ? part.text : "";
      })
      .filter(Boolean)
      .join("\n");
    return { text, hadImage };
  }
  try {
    return { text: JSON.stringify("value" in shaped ? shaped.value : output), hadImage: false };
  } catch {
    return { text: "", hadImage: false };
  }
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.7);
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters of older output trimmed; rerun the command if you need them ...]\n${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Shortens long string arguments (a whole file body) of an old tool call. */
function clipInput(input: unknown, limit: number): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] =
      typeof value === "string" && value.length > limit
        ? `${value.slice(0, limit)}\n[... ${value.length - limit} more characters were sent; the file on disk has the full text ...]`
        : value;
  }
  return out;
}

function trimMessage(message: ModelMessage, toolChars: number, inputChars: number, dropImagesOnly: boolean): ModelMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const next = (content as Part[]).map((part) => {
    if (part.type === "tool-result") {
      const { text, hadImage } = outputText(part.output);
      if (dropImagesOnly && !hadImage) return part;
      if (!hadImage && text.length <= toolChars) return part;
      changed = true;
      return { ...part, output: { type: "text", value: dropImagesOnly ? text : clip(text, toolChars) } };
    }
    if (part.type === "tool-call" && !dropImagesOnly) {
      const clipped = clipInput(part.input, inputChars);
      if (JSON.stringify(clipped) === JSON.stringify(part.input)) return part;
      changed = true;
      return { ...part, input: clipped };
    }
    if (isImagePart(part)) {
      changed = true;
      return { type: "text", text: IMAGE_GONE };
    }
    return part;
  });
  return changed ? ({ ...message, content: next } as ModelMessage) : message;
}

/**
 * Shrinks the older part of a worker conversation.
 * Why: every step resends everything before it. Long command output and file
 * bodies from many steps ago are rarely needed again, and the worker can
 * rerun a command to see them. Recent messages stay whole, and so does the
 * first one, which carries the brief. Message count and order never change,
 * so tool calls stay paired with their results.
 * Input: the conversation and how much to keep. Output: a new array.
 */
export function compactTranscript(
  messages: ModelMessage[],
  options?: { keepRecent?: number; toolChars?: number; inputChars?: number },
): ModelMessage[] {
  const keepRecent = options?.keepRecent ?? 12;
  const toolChars = options?.toolChars ?? 600;
  const inputChars = options?.inputChars ?? 400;
  const cut = Math.max(0, messages.length - keepRecent);
  return messages.map((message, index) => {
    if (index === 0 || index >= cut) return message;
    return trimMessage(message, toolChars, inputChars, false);
  });
}

/** Opens the note that stands in for collapsed steps; also how a later collapse recognises an earlier one. */
const COLLAPSED_HEAD = "[Earlier steps of this job were collapsed to keep it light.";
/** Most action lines one collapsed note keeps; older ones are only counted. */
const COLLAPSED_ACTIONS_KEPT = 40;
/** Most instruction notes one collapsed note keeps word for word. */
const COLLAPSED_NOTES_KEPT = 8;
const COLLAPSED_NOTE_CHARS = 1_500;

/** One tool call as a short line: the tool and the part of its input that says what it did. */
function actionLine(part: Part): string {
  const name = String(part.toolName ?? "tool");
  const input = (part.input ?? {}) as Record<string, unknown>;
  const said = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input);
  return `- ${name}: ${String(said ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
}

/** Text of a plain message, whether its content is a string or a list of parts. */
function plainText(message: ModelMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Replaces the oldest steps of a worker conversation with one short note.
 * Why: compactTranscript only shortens old steps and never removes them, so
 * every step still cost about 200 tokens at every later step, and its hidden
 * reasoning was resent in full by the provider. A job of 400 steps resent
 * 100,000 tokens of old steps each time it moved. The note keeps what matters
 * from them: the tools it ran, and every instruction it was given, word for word.
 * The first message (the brief) and the newest steps stay whole. A tool result
 * is never separated from its call, so the conversation stays valid.
 * Input: the conversation and how many of the newest messages to keep.
 * Output: a new, shorter array, or the same one when there is nothing old enough.
 */
export function collapseOldSteps(messages: ModelMessage[], keepRecent = 16): ModelMessage[] {
  let cut = messages.length - keepRecent;
  if (cut <= 2) return messages;
  // The kept part must not start with tool results whose calls were collapsed.
  while (cut < messages.length && messages[cut]!.role === "tool") cut += 1;
  if (cut <= 2 || cut >= messages.length) return messages;
  const actions: string[] = [];
  const notes: string[] = [];
  let earlierActions = 0;
  for (const message of messages.slice(1, cut)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Part[]) {
        if (part.type === "tool-call") actions.push(actionLine(part));
      }
      continue;
    }
    if (message.role !== "user") continue;
    const text = plainText(message).trim();
    if (!text) continue;
    if (text.startsWith(COLLAPSED_HEAD)) {
      // An earlier collapse: carry its notes and actions forward, not the note itself.
      const counted = /\((\d+) earlier tool calls/.exec(text);
      earlierActions += counted ? Number(counted[1]) : 0;
      const [, noteBlock = "", actionBlock = ""] = /Instructions given during those steps:\n([\s\S]*?)\n\nTools run[^\n]*\n([\s\S]*)$/.exec(text) ?? [];
      if (noteBlock.trim() && noteBlock.trim() !== "(none)") notes.push(...noteBlock.split("\n\n").filter(Boolean));
      actions.push(...actionBlock.split("\n").filter((line) => line.startsWith("- ")));
      continue;
    }
    notes.push(text.slice(0, COLLAPSED_NOTE_CHARS));
  }
  const keptActions = actions.slice(-COLLAPSED_ACTIONS_KEPT);
  earlierActions += actions.length - keptActions.length;
  const keptNotes = notes.slice(-COLLAPSED_NOTES_KEPT);
  const note = [
    `${COLLAPSED_HEAD} Their results are no longer in view: what was built is on disk, so look there or rerun a command if you need something again.]`,
    "",
    "Instructions given during those steps:",
    keptNotes.length > 0 ? keptNotes.join("\n\n") : "(none)",
    "",
    `Tools run in those steps, oldest first${earlierActions > 0 ? ` (${earlierActions} earlier tool calls not listed)` : ""}:`,
    ...keptActions,
  ].join("\n");
  return [messages[0]!, { role: "user", content: note }, ...messages.slice(cut)];
}

/** Tools whose result is a view of something that has since changed: the page, the screen. */
const VIEW_TOOLS = new Set(["browser_navigate", "browser_snapshot", "browser_read", "browser_screenshot", "computer_screenshot"]);
const VIEW_GONE = "[An earlier view of the page was here. The page has moved on since; take a new browser_snapshot to see it as it is now.]";

/**
 * Drops all but the newest views of a page or the screen.
 * Why: every step resends everything before it, and one snapshot of a page is
 * thousands of tokens. A job that clicks through a site carried every page it
 * had ever seen, at every later step: a short form cost 200,000 input tokens.
 * An old view is also wrong, since the page changed with the next action.
 * Input: the conversation and how many of the latest views to keep whole.
 * Output: a new array; message count and order are unchanged, so calls stay paired with results.
 */
export function dropStaleViews(messages: ModelMessage[], keep = 2): ModelMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]!;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    let changed = false;
    const next = [...(content as Part[])];
    for (let at = next.length - 1; at >= 0; at -= 1) {
      const part = next[at]!;
      if (part.type !== "tool-result" || !VIEW_TOOLS.has(String(part.toolName ?? ""))) continue;
      seen += 1;
      if (seen <= keep) continue;
      const { text, hadImage } = outputText(part.output);
      // A short answer (an error, "the browser did not start") costs nothing to keep and may matter.
      if (!hadImage && text.length <= 400) continue;
      // The address and title, on the first lines, say where the job has been.
      const first = hadImage ? "" : `${text.split("\n").slice(0, 2).join(" ").slice(0, 200)}\n`;
      next[at] = { ...part, output: { type: "text", value: `${first}${VIEW_GONE}` } };
      changed = true;
    }
    if (changed) out[index] = { ...message, content: next } as ModelMessage;
  }
  return out;
}

/** Rough size of a conversation in model tokens (four characters each). */
export function estimateTokens(messages: ModelMessage[]): number {
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

/**
 * When the conversation should be shrunk, in tokens.
 * Why: weak models lose the thread long before a large window is full, and a
 * small window must keep room for the reply.
 * Input: the model's context window, when known. Output: the threshold.
 */
export function compactionThreshold(contextWindow?: number | null): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
  // The ceiling was 90,000. A long job then resent up to that much at every one of its steps, which
  // is most of what such a job costs; the old output it kept is rarely read again and can be rerun.
  return Math.max(24_000, Math.min(Math.floor(window * 0.55), 48_000));
}

/**
 * The conversation as it is stored for a later continuation.
 * Why: pictures are megabytes of base64 and useless later, and the row must
 * stay small. Shrinks harder until it fits.
 * Input: the live conversation. Output: a storable copy.
 */
export function transcriptForStorage(messages: ModelMessage[], maxChars = TRANSCRIPT_STORE_CHARS): ModelMessage[] {
  let stored = messages.map((message) => trimMessage(message, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true));
  const size = (list: ModelMessage[]): number => {
    try {
      return JSON.stringify(list).length;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };
  for (const pass of [
    { keepRecent: 16, toolChars: 1_500, inputChars: 800 },
    { keepRecent: 10, toolChars: 500, inputChars: 300 },
    { keepRecent: 4, toolChars: 200, inputChars: 150 },
    { keepRecent: 0, toolChars: 120, inputChars: 100 },
  ]) {
    if (size(stored) <= maxChars) return stored;
    stored = compactTranscript(stored, pass);
  }
  return stored;
}

/**
 * Makes a stored conversation safe to continue from.
 * Why: a run can be cut off between a tool call and its result (a stop, a
 * restart). Providers reject a call with no answer, so anything after the
 * last complete exchange is dropped.
 * Input: stored messages. Output: the longest prefix that ends cleanly.
 */
export function resumableTranscript(messages: unknown[]): ModelMessage[] {
  const list = (Array.isArray(messages) ? messages : []).filter(
    (message): message is ModelMessage =>
      Boolean(message) && typeof message === "object" && typeof (message as { role?: unknown }).role === "string",
  );
  const callIds = (message: ModelMessage): string[] => {
    const content = (message as { content?: unknown }).content;
    if (message.role !== "assistant" || !Array.isArray(content)) return [];
    return (content as Part[]).filter((part) => part.type === "tool-call").map((part) => String(part.toolCallId ?? ""));
  };
  const resultIds = (message: ModelMessage | undefined): Set<string> => {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (!message || message.role !== "tool" || !Array.isArray(content)) return new Set();
    return new Set(
      (content as Part[]).filter((part) => part.type === "tool-result").map((part) => String(part.toolCallId ?? "")),
    );
  };
  let end = list.length;
  for (let index = 0; index < list.length; index += 1) {
    const calls = callIds(list[index]!);
    if (calls.length === 0) continue;
    const answered = resultIds(list[index + 1]);
    if (!calls.every((id) => answered.has(id))) {
      end = index;
      break;
    }
  }
  return list.slice(0, end);
}
