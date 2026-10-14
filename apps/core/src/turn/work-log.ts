/**
 * The agent's private record of what it did in earlier turns.
 * Why: the chat history used to be rebuilt from visible bubbles only, so tool
 * calls, tool results and worker reports vanished between turns and the agent
 * re-read the same skills and pages on every wake. Each run's tool calls are
 * saved clipped, then replayed as one short private note placed just before
 * that run's reply. Recent runs keep more detail; older ones shrink to a line
 * per call. DB: reads/writes work_log.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { workLog, type WorkLogEntry } from "../db/schema.js";
import { prompt } from "../prompt/prompts.js";

type Db = ReturnType<typeof getDb>;

/** Stored size caps: enough to act on later, small enough to keep rows light. */
const STORED_INPUT_CHARS = 300;
const STORED_OUTPUT_CHARS = 1_500;
const STORED_CUE_CHARS = 3_000;
const STORED_ENTRIES = 30;

/** Replay caps. The newest runs are shown in detail, older ones as a digest. */
const DETAILED_RUNS = 3;
const DETAILED_OUTPUT_CHARS = 1_200;
const DETAILED_CUE_CHARS = 2_500;
const BRIEF_OUTPUT_CHARS = 160;
const BRIEF_CUE_CHARS = 400;
const BRIEF_ENTRIES = 8;
/** Work logs loaded per turn. */
export const WORK_LOG_RUNS = 8;

function oneLine(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length} chars]`;
}

/** The argument that identifies a call, so the log reads like a sentence, not JSON. */
function mainInput(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string): string | null => (typeof input[key] === "string" ? (input[key] as string) : null);
  const main =
    pick("path") ?? pick("url") ?? pick("name") ?? pick("query") ?? pick("pattern") ?? pick("task") ?? pick("set");
  if (main !== null) return main;
  if (tool === "send_message") return "";
  return oneLine(input);
}

/** Tools whose result is a page's structure tree: useless later, and long. */
const PAGE_TREE_TOOLS = new Set(["browser_navigate", "browser_snapshot"]);

/**
 * What of a result is worth replaying later.
 * Why: a page tree ("generic - link [ref=e123] …") filled 1,500 characters of
 * every later prompt per call and told the agent nothing; its first lines,
 * the page title and address, say where it went.
 */
function keptOutput(tool: string, output: unknown): string {
  if (PAGE_TREE_TOOLS.has(tool) && typeof output === "string") {
    const tree = output.search(/\n\s*- /);
    return tree < 0 ? output : `${output.slice(0, tree)} [page structure not kept]`;
  }
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

/** Builds one stored entry from a finished tool call. */
export function workEntry(tool: string, input: Record<string, unknown>, output: unknown, failed: boolean): WorkLogEntry {
  return {
    tool,
    input: clip(oneLine(mainInput(tool, input)), STORED_INPUT_CHARS),
    output: clip(oneLine(keptOutput(tool, output)), STORED_OUTPUT_CHARS),
    ...(failed ? { failed: true } : {}),
  };
}

/** Saves one run's work for one agent. Nothing to record means no row. */
export async function saveWorkLog(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    runId: string;
    cue?: string;
    entries: WorkLogEntry[];
  },
): Promise<void> {
  // Bubbles are already in the room; only work and private notes need recording.
  const entries = input.entries.filter((entry) => entry.tool !== "send_message").slice(0, STORED_ENTRIES);
  const cue = input.cue?.trim() ? clip(input.cue.trim(), STORED_CUE_CHARS) : null;
  if (entries.length === 0 && !cue) return;
  await db.insert(workLog).values({
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    runId: input.runId,
    cue,
    entries,
  });
}

export type WorkLogRow = { runId: string | null; cue: string | null; entries: WorkLogEntry[]; createdAt: Date };

/** Loads this agent's recent work in one room, oldest first. */
export async function recentWorkLogs(
  db: Db,
  input: { accountId: string; conversationId: string; agentId: string; since: Date },
): Promise<WorkLogRow[]> {
  const rows = await db
    .select({ runId: workLog.runId, cue: workLog.cue, entries: workLog.entries, createdAt: workLog.createdAt })
    .from(workLog)
    .where(
      and(
        eq(workLog.accountId, input.accountId),
        eq(workLog.conversationId, input.conversationId),
        eq(workLog.agentId, input.agentId),
        gte(workLog.createdAt, input.since),
      ),
    )
    .orderBy(desc(workLog.createdAt))
    .limit(WORK_LOG_RUNS);
  return rows.reverse();
}

/** Renders one run's work as a private note. `detailed` keeps real output; otherwise a digest. */
export function renderWorkLog(row: WorkLogRow, detailed: boolean): string {
  const outputChars = detailed ? DETAILED_OUTPUT_CHARS : BRIEF_OUTPUT_CHARS;
  const entries = detailed ? row.entries : row.entries.slice(0, BRIEF_ENTRIES);
  const lines = entries
    .map((entry) =>
      prompt("dispatcher", "work-log-line", {
        tool: entry.failed ? `${entry.tool} (failed)` : entry.tool,
        input: entry.input,
        output: clip(entry.output, outputChars),
      }),
    )
    .join("\n");
  const note = row.cue
    ? `${prompt("dispatcher", "work-log-note", { cue: clip(row.cue, detailed ? DETAILED_CUE_CHARS : BRIEF_CUE_CHARS) })}\n`
    : "";
  return prompt("dispatcher", "work-log", { note, lines }).trim();
}

type Message = { role: "user" | "assistant"; content: unknown };

/**
 * Places each run's work log just before that run's first reply.
 * Input: recent rows (id/run/author/time), the model messages built from them
 * (same order and length), and the work logs oldest first.
 * Output: the model messages with private notes woven in. A run with no
 * reply in the window is placed by time.
 */
export function weaveWorkLogs<T extends Message>(
  rows: { runId?: string | null; agentId: string | null; createdAt: Date }[],
  modelMessages: T[],
  logs: WorkLogRow[],
): T[] {
  if (logs.length === 0) return modelMessages;
  const detailedFrom = Math.max(logs.length - DETAILED_RUNS, 0);
  const notes = logs.map((row, index) => ({
    row,
    placed: false,
    message: { role: "user", content: renderWorkLog(row, index >= detailedFrom) } as T,
  }));
  const byRun = new Map(notes.filter((note) => note.row.runId).map((note) => [note.row.runId!, note]));
  const out: T[] = [];
  rows.forEach((row, index) => {
    // Runs that left no reply in the window still belong in time order.
    for (const note of notes) {
      if (!note.placed && note.row.createdAt.getTime() <= row.createdAt.getTime() && !hasReplyInWindow(rows, note.row.runId)) {
        out.push(note.message);
        note.placed = true;
      }
    }
    const note = row.agentId && row.runId ? byRun.get(row.runId) : undefined;
    if (note && !note.placed) {
      out.push(note.message);
      note.placed = true;
    }
    out.push(modelMessages[index]!);
  });
  for (const note of notes) {
    if (!note.placed) out.push(note.message);
  }
  return out;
}

function hasReplyInWindow(rows: { runId?: string | null; agentId: string | null }[], runId: string | null): boolean {
  if (!runId) return false;
  return rows.some((row) => row.agentId && row.runId === runId);
}
