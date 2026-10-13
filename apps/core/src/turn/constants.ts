/** Heartbeat interval while a run holds the model. DB: updates `runs` heartbeat. */
export const HEARTBEAT_MS = 30_000;

/** Parent → child → grandchild delegation cap. */
export const MAX_DELEGATION_DEPTH = 2;

export const DELEGATION_HISTORY_SLICE = 10;

/** Parent quick peek at one public URL or search (output also capped by fetch chars). */
export const DISPATCHER_TOOL_BUDGET_WEB_MS = 20_000;

/** Parent read/glob/grep on known paths. */
export const DISPATCHER_TOOL_BUDGET_LOCAL_MS = 8_000;

/** A quick command the chat agent runs itself; anything longer belongs to a worker. */
export const DISPATCHER_TOOL_BUDGET_SHELL_MS = 20_000;

/** The chat agent opening or reading one page in its own browser. */
export const DISPATCHER_TOOL_BUDGET_BROWSER_MS = 40_000;

/** Other dispatcher tools (DB, MCP, list_skills, …). */
export const DISPATCHER_TOOL_BUDGET_DEFAULT_MS = 15_000;

/**
 * Dispatcher step cap. Every step resends the whole prompt + tool schemas, so
 * a long dispatcher loop is the most expensive place to do work. Eight covers
 * a small job done by the agent itself (a command, a file, a page read) plus
 * the answer or the handoff; the last step is closing-only. It was five while
 * the chat agent could only look things up.
 */
export const MAX_MODEL_STEPS_DISPATCHER = 8;

/** Hard stop for one chat-agent turn, behind the closing rule (which stretches for team setup). */
export const MAX_MODEL_STEPS_HARD = 14;

/** Dispatcher output cap. Reasoning models spend most of this on thinking — keep headroom for send_message. */
export const DISPATCHER_MAX_OUTPUT_TOKENS = 4_096;

export const MAX_VISION_IMAGES = 3;
export const MAX_VISION_CHARS = 1_000_000;

/**
 * Context window policy (keeps the agent sharp over a years-long thread).
 * RECENT_WINDOW: newest messages kept verbatim in the prompt + model messages.
 * FOLD_BATCH: minimum aged-out messages before a fold runs (avoids tiny folds).
 * SUMMARY_WINDOW: most-recent folded summary items injected every turn; older
 * ones are reached by semantic recall, not dumped into every tail.
 * RECALL_K: top semantically-relevant durable items pulled back per turn.
 */
export const RECENT_WINDOW = 24;
export const FOLD_BATCH = 20;
export const SUMMARY_WINDOW = 24;
export const RECALL_K = 8;

/**
 * Per-message cap for recent model messages (years-long threads stay sharp
 * and bounded). Full bodies stay in the DB and read_history; only the
 * prompt copy is shortened, with an ellipsis marker.
 */
export const TAIL_MESSAGE_CHARS = 2_000;
