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
/**
 * Times it is told to start doing before it must report instead. A worker
 * once read for 200 tool calls through two such nudges and delivered nothing;
 * the report it writes instead can be continued, so no work is lost.
 */
export const LOOK_ONLY_NUDGES_BEFORE_STOP = 2;
/**
 * Steps in a row that each made one small call before the worker is told to combine them.
 * Why: every step resends the whole conversation (40-60k tokens), and one
 * Reddit job spent 125 steps at one click, fill or check each, 5.8M tokens for
 * four comments. Batching independent calls in one step and known sequences in
 * one browser_batch finishes the same work in a fraction of the steps.
 */
export const SINGLE_CALL_NUDGE_AFTER = 2;
/** Most times one run is told to combine its steps; past that, telling again only adds text. */
export const SINGLE_CALL_NUDGES_MAX = 3;
/**
 * Fewest steps between two such reminders.
 * Why: with a streak of 2, the opening steps of almost any job (open a page, read
 * it) used up every reminder in the first ~18 steps, and none was left for the
 * long wasteful stretch later (that Reddit job spent steps 76-120 re-checking one comment).
 */
export const SINGLE_CALL_NUDGE_GAP = 15;

/** How much of what a collapsed step returned stays in view. */
const COLLAPSED_RESULT_CHARS = 160;
/** Steps left when the worker is warned the ceiling is near. */
export const WRAP_UP_WARNING_STEPS = 8;
/**
 * Longest answer one worker step may write, in tokens.
 * Why: with no limit the provider reserves credit for the model's maximum
 * (65,536 on one model) on every step, and refused steps the account could
 * easily pay for. Too low, and a long file was cut off mid-call. This fits
 * a file of several hundred lines plus the model's thinking; a step that is
 * cut off anyway is told to write in parts, and the limit is raised.
 */
export const WORKER_OUTPUT_TOKENS = 24_000;
/** Never ask for less than this, even when credit is short: below it most steps cannot finish. */
export const MIN_OUTPUT_TOKENS = 4_096;

/**
 * Why one step stopped at the output limit, or null when it did not.
 * "thinking": it wrote no text and called no tool, so the whole answer was hidden
 * thinking; a larger limit only makes it think longer. "output": a long answer
 * or file body was cut off mid-way, which a larger limit or parts can fix.
 */
export function cutKind(step: { finishReason?: string; text?: string; toolCalls?: unknown[] }): "thinking" | "output" | null {
  if (step.finishReason !== "length") return null;
  return (step.toolCalls?.length ?? 0) === 0 && !step.text?.trim() ? "thinking" : "output";
}

/** The output limit for a model, from its own maximum when known. */
export function workerOutputCap(modelMax: number | null | undefined): number {
  return modelMax && modelMax > 0 ? Math.max(Math.min(modelMax, WORKER_OUTPUT_TOKENS), Math.min(modelMax, MIN_OUTPUT_TOKENS)) : WORKER_OUTPUT_TOKENS;
}

/**
 * The tokens a provider said it can still pay for, from its refusal.
 * Input: the error. Output: the number, or null for any other error.
 * OpenRouter: "You requested up to 65536 tokens, but can only afford 21083."
 */
export function affordableTokens(error: unknown): number | null {
  const text = error instanceof Error ? `${error.message} ${String((error as { responseBody?: unknown }).responseBody ?? "")}` : String(error);
  const match = /can only afford (\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Most input tokens one worker run may send, cached or not, before it must report.
 * Why: a run used to be stopped only by its step count, so when something
 * made every step huge (a plugin's 137 tool definitions), one job spent
 * 23 million tokens. At a normal 30,000 to 50,000 tokens a step this is far
 * beyond the step ceiling; it only bites when steps are abnormally large.
 * The job can be continued from its report.
 */
export const WORKER_RUN_INPUT_TOKENS = 8_000_000;
/** Share of a run's token budget at which it is told to finish up and report. */
export const BUDGET_WARN_SHARE = 0.75;
/** Average input per step above which the person is told something is off. Normal is 30,000 to 50,000. */
export const STEP_INPUT_ALARM = 90_000;
/** Steps averaged before the alarm is judged, so one large page does not set it off. */
export const STEP_ALARM_AFTER = 6;

/** Largest conversation kept for a later continuation, as JSON characters. */
export const TRANSCRIPT_STORE_CHARS = 600_000;

const LOOK_ONLY_TOOLS = new Set([
  "read",
  "todo_write",
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
/**
 * A step that made one small call: one page action, one page read, one fetch or search.
 * A shell command is never small here: one command can do a whole job.
 */
export function isSingleSmallCallStep(calls: { name: string }[]): boolean {
  if (calls.length !== 1) return false;
  const name = calls[0]?.name ?? "";
  if (name === "browser_batch") return false;
  return name.startsWith("browser_") || name === "web_fetch" || name === "web_search" || name === "read" || name === "glob" || name === "grep";
}

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
function actionLine(part: Part, returned?: string): string {
  const name = String(part.toolName ?? "tool");
  const input = (part.input ?? {}) as Record<string, unknown>;
  const said = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : JSON.stringify(input);
  const result = returned?.replace(/\s+/g, " ").trim();
  return `- ${name}: ${String(said ?? "").replace(/\s+/g, " ").slice(0, 120)}${result ? ` → ${result.slice(0, COLLAPSED_RESULT_CHARS)}${result.length > COLLAPSED_RESULT_CHARS ? "…" : ""}` : ""}`;
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
  // What each call returned, so the summary says what was learned, not only what was run:
  // without it a worker re-read the same files after every collapse.
  const returned = new Map<string, string>();
  for (const message of messages.slice(1, cut)) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Part[]) {
      if (part.type === "tool-result") returned.set(String(part.toolCallId ?? ""), outputText(part.output ?? part.result).text);
    }
  }
  for (const message of messages.slice(1, cut)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Part[]) {
        if (part.type === "tool-call") actions.push(actionLine(part, returned.get(String(part.toolCallId ?? ""))));
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
    `${COLLAPSED_HEAD} Each tool call below shows the start of what it returned. Trust these and what is on disk; read something again only if it has changed since, or you need a detail that is not here.]`,
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
const VIEW_TOOLS = new Set(["browser_navigate", "browser_snapshot", "browser_batch", "browser_read", "browser_screenshot", "computer_screenshot"]);
const VIEW_GONE = "[An earlier view of the page was here. The page has moved on since; take a new browser_snapshot to see it as it is now.]";
const BATCH_VIEW_HEAD = "\n\nPage now (what changed since your last view):\n";

/** A snapshot answer that lists only what changed, or says nothing did: it builds on the full tree before it. */
function isPageChange(text: string): boolean {
  return text.startsWith("Changed since your last snapshot") || text.startsWith("Nothing changed on the page");
}

/**
 * Drops views of a page or the screen that the newest ones have replaced.
 * Why: every step resends everything before it, and one snapshot of a page is
 * thousands of tokens. A job that clicks through a site carried every page it
 * had ever seen, at every later step: a short form cost 200,000 input tokens.
 * Kept: the newest full page tree with every change-only snapshot after it
 * (together they are the page as it is now), the newest page text read, and the
 * newest picture. Keeping only the two newest views used to drop the tree that
 * the change-only answers build on, so workers asked for the whole page again:
 * 19 of 54 page views in one job were full trees asked for that way.
 * Input: the conversation. Output: a new array; message count and order are
 * unchanged, so calls stay paired with results.
 */
export function dropStaleViews(messages: ModelMessage[]): ModelMessage[] {
  let haveTree = false;
  let haveRead = false;
  let havePicture = false;
  const out = [...messages];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]!;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    let changed = false;
    const next = [...(content as Part[])];
    for (let at = next.length - 1; at >= 0; at -= 1) {
      const part = next[at]!;
      const name = String(part.toolName ?? "");
      if (part.type !== "tool-result" || !VIEW_TOOLS.has(name)) continue;
      const { text, hadImage } = outputText(part.output);
      const batchSplit = name === "browser_batch" ? text.indexOf(BATCH_VIEW_HEAD) : -1;
      const view = batchSplit >= 0 ? text.slice(batchSplit + BATCH_VIEW_HEAD.length) : name === "browser_batch" ? "" : text;
      if (hadImage || name.endsWith("_screenshot")) {
        if (!havePicture) {
          havePicture = true;
          continue;
        }
      } else if (name === "browser_read") {
        if (!haveRead) {
          haveRead = true;
          continue;
        }
      } else if (!haveTree) {
        // Change-only answers stay until the full tree they build on is reached; that tree stays too.
        // A short answer (an error, a click result) is not the tree.
        if (!isPageChange(view) && view.length > 400) haveTree = true;
        continue;
      }
      // A short answer (an error, "the browser did not start") costs nothing to keep and may matter.
      if (!hadImage && view.length <= 400) continue;
      // The address and title, on the first lines, say where the job has been.
      const first = hadImage ? "" : `${view.split("\n").slice(0, 2).join(" ").slice(0, 200)}\n`;
      const prefix = batchSplit >= 0 ? `${text.slice(0, batchSplit)}\n\n` : "";
      next[at] = { ...part, output: { type: "text", value: `${prefix}${first}${VIEW_GONE}` } };
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
 * Most a worker's conversation may grow to before it is summarized, in tokens,
 * not counting the instructions and tool definitions sent beside it.
 * Why: every step resends the whole conversation. At 150,000 the summary
 * almost never ran, so old results were cut short instead and kept: a video
 * job carried 196 cut calls (about 43,000 tokens) on every step, sent 60,000
 * to 90,000 tokens a step and about 29 million in all, and re-read what the
 * cuts had removed. Summarized here, a step stays near 20,000 to 45,000 plus
 * the instructions, and what was learned is kept as a summary, not lost to a cut.
 */
export const WORKER_CONTEXT_CEILING = 45_000;

/**
 * When the conversation should be summarized, in tokens: 80% of the window, at most the ceiling.
 * Why a summary, not cuts: the threshold was once 48,000 counting ~35,000 of
 * instructions, and old results were cut every few steps; workers forgot what
 * they had read and read it again (236 steps for a 9-step job), and each cut
 * changed old messages, so the provider's cache no longer matched. A summary
 * keeps what was learned, and between summaries nothing old is rewritten.
 * Input: the model's context window, when known. Output: the threshold.
 */
export function compactionThreshold(contextWindow?: number | null): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 128_000;
  return Math.max(24_000, Math.min(Math.floor(window * 0.8), WORKER_CONTEXT_CEILING));
}

/** Newest part of the conversation kept word for word beside a state summary, in tokens. */
export const SUMMARY_KEEP_RECENT_TOKENS = 15_000;
/** Opens the message that holds a state summary; also how a later summary finds the earlier one. */
export const STATE_HEAD = "[Earlier steps of this job were replaced by this state summary.";
const INSTRUCTIONS_HEAD = "## Instructions from the agent, word for word";
const SUMMARY_HEAD = "## State of the job";
const WORKLIST_HEAD = "## Your worklist (todo_write)";
/** Messages from the agent, as the loop words them (agent-note, continue-message). */
const AGENT_WORDS = /^(Note from the agent you work for|The agent you work for has more for you)/;
const INSTRUCTIONS_KEPT = 8;
const INSTRUCTION_CHARS = 4_000;

/**
 * Splits a conversation for a state summary: the brief, the older part, and the newest part kept whole.
 * Input: the conversation and how many tokens of the newest part to keep.
 * Output: the parts, or null when there is too little to summarize. The newest
 * part never starts with tool results whose calls would be left behind.
 */
export function splitForSummary(
  messages: ModelMessage[],
  keepTokens = SUMMARY_KEEP_RECENT_TOKENS,
): { brief: ModelMessage; older: ModelMessage[]; recent: ModelMessage[] } | null {
  let cut = messages.length;
  let kept = 0;
  while (cut > 1) {
    const size = estimateTokens([messages[cut - 1]!]);
    if (kept + size > keepTokens && messages.length - cut >= 2) break;
    kept += size;
    cut -= 1;
  }
  while (cut < messages.length && messages[cut]!.role === "tool") cut += 1;
  if (cut <= 1 || cut >= messages.length) return null;
  return { brief: messages[0]!, older: messages.slice(1, cut), recent: messages.slice(cut) };
}

/**
 * What the agent told the worker during the older part, word for word, including what an earlier summary carried.
 * Why: a summary written by the model can drift from what was asked; these are kept by code.
 */
export function agentInstructions(older: ModelMessage[]): string[] {
  const found: string[] = [];
  for (const message of older) {
    if (message.role !== "user") continue;
    const text = plainText(message).trim();
    if (text.startsWith(STATE_HEAD)) {
      const block = text.split(INSTRUCTIONS_HEAD)[1]?.split(SUMMARY_HEAD)[0]?.split(WORKLIST_HEAD)[0] ?? "";
      found.push(...block.split("\n\n---\n\n").map((item) => item.trim()).filter((item) => item && item !== "(none)"));
      continue;
    }
    if (AGENT_WORDS.test(text)) found.push(text.slice(0, INSTRUCTION_CHARS));
  }
  return found.slice(-INSTRUCTIONS_KEPT);
}

/** The worklist lines an earlier state summary in this part of the conversation carried, newest first found. */
function earlierWorklist(older: ModelMessage[]): string[] {
  for (const message of [...older].reverse()) {
    if (message.role !== "user") continue;
    const text = plainText(message);
    if (!text.startsWith(STATE_HEAD) || !text.includes(WORKLIST_HEAD)) continue;
    const block = text.split(WORKLIST_HEAD)[1]?.split(SUMMARY_HEAD)[0] ?? "";
    return block.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- ["));
  }
  return [];
}

/**
 * The conversation after a state summary: the brief, one summary message, then the newest steps unchanged.
 * Input: the split parts and the summary the model wrote. Output: the new conversation.
 */
export function withStateSummary(
  parts: { brief: ModelMessage; older: ModelMessage[]; recent: ModelMessage[] },
  summary: string,
  todos: readonly { content: string; status: string }[] = [],
): ModelMessage[] {
  const instructions = agentInstructions(parts.older);
  // The worklist is the worker's own, kept by code like the agent's words, so no summary can drop an item.
  // A continued run has none of its own yet: the one the last summary carried stands.
  const items = todos.length > 0 ? todos.map((todo) => `- [${todo.status}] ${todo.content}`) : earlierWorklist(parts.older);
  const worklist = items.length > 0 ? ["", WORKLIST_HEAD, ...items] : [];
  const note = [
    `${STATE_HEAD} Trust it and the files on disk; open a file again only to use a detail that is not here, and never redo anything listed as done.]`,
    "",
    INSTRUCTIONS_HEAD,
    instructions.length > 0 ? instructions.join("\n\n---\n\n") : "(none)",
    ...worklist,
    "",
    SUMMARY_HEAD,
    summary.trim(),
  ].join("\n");
  return [parts.brief, { role: "user", content: note }, ...parts.recent];
}

/** Below this size (estimated tokens) old page views are left alone, so the cached prefix stays the same. */
export const STALE_VIEWS_AT = 16_000;

/** The conversation with every picture replaced by a short note; nothing else changes. */
export function withoutImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => trimMessage(message, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true));
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

/** Steps the stuck watch looks back over. */
const STUCK_WINDOW = 12;
/** Tries on one target within the window that count as stuck. */
const STUCK_TARGET_TRIES = 5;
/** Steps in a row where every call failed that count as stuck. */
const STUCK_FAIL_STREAK = 4;

/** What a step's calls act on: element refs, CSS selectors in scripts, form fields, addresses. */
export function callTargets(calls: { name: string; input: unknown }[]): string[] {
  const targets = new Set<string>();
  for (const call of calls) {
    const input = (call.input ?? {}) as Record<string, unknown>;
    for (const key of ["uid", "to", "field", "url"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) targets.add(`${key}:${value.trim().replace(/^@/, "").toLowerCase()}`);
    }
    for (const key of ["script", "command"]) {
      const text = input[key];
      if (typeof text !== "string") continue;
      // A selector is the same target however the script around it is worded.
      for (const match of text.matchAll(/querySelector(?:All)?\(\s*(['"`])(.+?)\1/g)) targets.add(`css:${match[2]!.trim().toLowerCase()}`);
    }
  }
  return [...targets];
}

/** True when every result in a step reports a failure. */
export function stepFailed(results: unknown[]): boolean {
  if (results.length === 0) return false;
  return results.every((result) => {
    const raw = (result as { output?: unknown }).output ?? result;
    const value = raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
    const text = (typeof value === "string" ? value : JSON.stringify(value ?? "")).slice(0, 400);
    return /^\s*(✗|error\b|failed\b)|\b(is covered by|could not|did not take|not found|timed out|timeout|no such|unknown ref)\b/i.test(text);
  });
}

/**
 * Notices a worker that keeps trying the same thing without getting anywhere.
 * Why: a worker spent 150 steps on one dropdown, alternating a click that was
 * refused with scripts worded a little differently each time. No two calls in
 * a row were the same, so the repeat check never fired. This watches what is
 * being acted on and whether it works: the same target tried again and again
 * within a few steps, or a run of steps where every call failed.
 */
export class StuckWatch {
  private history: string[][] = [];
  private failStreak = 0;

  /** Records one step. Output: why the worker looks stuck, or null. */
  record(calls: { name: string; input: unknown }[], results: unknown[]): string | null {
    if (calls.length === 0) return null;
    this.history = [...this.history, callTargets(calls)].slice(-STUCK_WINDOW);
    this.failStreak = stepFailed(results) ? this.failStreak + 1 : 0;
    if (this.failStreak >= STUCK_FAIL_STREAK) return `the last ${this.failStreak} steps all failed`;
    const tries = new Map<string, number>();
    for (const step of this.history) for (const target of step) tries.set(target, (tries.get(target) ?? 0) + 1);
    const worst = [...tries.entries()].sort((left, right) => right[1] - left[1])[0];
    if (worst && worst[1] >= STUCK_TARGET_TRIES) return `${worst[1]} tries on ${worst[0].replace(/^\w+:/, "")} in the last ${this.history.length} steps`;
    return null;
  }

  /** Starts counting again after the worker was told to change course. */
  reset(): void {
    this.history = [];
    this.failStreak = 0;
  }
}
