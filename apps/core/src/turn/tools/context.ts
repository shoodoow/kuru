/**
 * Per-turn tool execution context.
 * Why: handlers stay pure; registry adds trace + timing. DB: handlers touch messages, delegations, etc.
 */
import type { getDb, Store } from "../../db/client.js";
import type { messages, WorkLogEntry } from "../../db/schema.js";
import type { TurnEvent } from "../../rooms/send-message.js";
import type { TraceSession } from "../trace/plugins.js";
import type { GenerateResult, TurnInput } from "../types.js";

type Db = ReturnType<typeof getDb>;

export type ToolContext = {
  db: Db;
  store: Store;
  accountId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  skillsRoot?: string;
  nextTime: () => Date;
  emittedMessages: (typeof messages.$inferSelect)[];
  emit: (event: TurnEvent) => Promise<void>;
  viaAgentId?: string | null;
  delegationDepth?: number;
  traceSession?: TraceSession;
  generate?: (input: TurnInput) => Promise<GenerateResult>;
  /** Room kind for tool filtering (direct chats get a slim set). Set by speaker. */
  roomKind?: string;
  /** Per-turn spawn guard: mutated by executors. Caps retry-burn. */
  spawnCount?: number;
  /**
   * Recent tool calls this turn (name + JSON input), mutated by the registry
   * wrapper. Powers the generic doom-loop detector: 3 identical calls in a
   * row never execute — the model gets a stop error instead.
   */
  recentCalls?: { name: string; input: string }[];
  /** Tool calls made in the model step now running; reset when a step starts. */
  stepCalls?: number;
  /** The model repeated a call or flooded a step with calls: the turn may only close now. */
  stuck?: boolean;
  /** Linux username for cheap parent tools (read/search/fetch). */
  linuxProfile?: string | null;
  /** Stop the model loop after this tool (secret-request). */
  endTurn?: boolean;
  /** Finished tool calls this turn, clipped; saved as the run's work log. */
  workEntries?: WorkLogEntry[];
  /** Read-type calls that already succeeded this turn, keyed by tool + input. */
  loaded?: Set<string>;
  /** A worker's reads of each file, page or listing this run (result-guard.ts). */
  readCounter?: import("./result-guard.js").ReadCounter;
  /** A worker's own worklist for this run (todo_write); carried whole into every state summary. */
  workerTodos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  /** Optional tool sets on for this turn (see tool-sets.ts). Mutated by enable_tools. */
  enabledToolSets?: Set<string>;
  /**
   * Set by the chat agent's loop to let large plugins load on request: each of
   * their tools mapped to the set that shows it, and each "load" tool mapped
   * to the set it turns on. Workers use the same maps for the browser and desktop tools too.
   */
  pluginGates?: Map<string, string>;
  pluginLoaders?: Map<string, string>;
  /** Workers: every plugin, however small, starts as its load tool (see rooms/worker-tool-families.ts). */
  lazyEveryPlugin?: boolean;
  /** Paths, URLs and skills this agent already looked at this turn; handed to workers so they skip them. */
  touched?: Set<string>;
  /** A worker or teammate was started this turn; the loop ends once the person has a bubble. */
  handedOff?: boolean;
  /** Hidden wake (worker result, routine): no opening ack is owed and silence is allowed. */
  /** Messages passed to other agents this turn. */
  agentMessages?: number;
  hiddenTurn?: boolean;
  /** Agent id that should speak Auto-review cards (parent when a worker is blocked). */
  voiceAgentId?: string;
  /** Worker runs: a blocked call pauses on the approval card instead of returning an error. */
  waitOnApproval?: {
    signal?: AbortSignal;
    /** Called when the wait starts and ends, and now and then while waiting. */
    onState?: (state: "waiting" | "resumed" | "tick") => Promise<void> | void;
  };
};
