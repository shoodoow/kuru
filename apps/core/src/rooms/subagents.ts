import { delegateSchema, spawnWorkerInputSchema, subagentCreateSchema, workerRefSchema } from "@kuru/agent-tools";
import { randomSurpriseMark } from "@kuru/shared";
import {
  packWorkerJobDescription,
  unpackWorkerJobDescription,
  workerPreambleFor,
  type WorkerKind,
} from "./worker-kinds.js";

import { workerToolNames as agentWorkerToolNames } from "@kuru/agent-tools";
import { generateText, isStepCount, NoSuchToolError, type ModelMessage } from "ai";
import { activeWorkerTools, deferredToolsBlock, pluginToolKey } from "../turn/tools/tool-sets.js";
import { stripLeakedToolCall } from "../turn/loop-control.js";
import { gateToolFamilies, startNamedPlugins, startingFamilies } from "./worker-tool-families.js";
import { isNoImageInputError, learnCapability, modelCapabilities } from "../model/capabilities.js";
import { imageDescriber, type ImageDescriber } from "../turn/describe-image.js";
import { budgetReachedMessage, budgetState, warnAboutBudget } from "../turn/usage/budget.js";
import { saveNotification } from "../notify/notify.js";
import { creditOutage, isOutOfCreditError, noteCreditOutage, OutOfCreditError, clearCreditOutage } from "../model/credit.js";
import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Store } from "../db/client.js";
import type { getDb } from "../db/client.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { cachedSystem, openAiCacheOptions, promptCacheKey, stepMessages } from "../model/cache-hints.js";
import { resolveGatewayContextWindow } from "../model/gateway-models.js";
import { buildWorkerToolSet } from "../turn/tools/build-tools.js";
import type { ToolContext } from "../turn/tools/context.js";
import { appendEvent } from "./events.js";
import { readSkillForAgent, skillCatalogForAgent } from "../skills/agent-skills.js";
import { budgetedCatalog, catalogBudgetTokens, hiddenSkillsLine, skillsForAgent } from "../skills/catalog-budget.js";
import { skillDirectoryOf, skillExcerpt } from "../skills/skill-excerpt.js";
import { prompt } from "../prompt/prompts.js";
import { publish } from "./stream.js";
import { accountHome, createProfile, exec, execStdin } from "../linux/linux.js";
import { appendMcpTools } from "../mcp/tools.js";
import { wrapToolExecute } from "../turn/tools/wrap-tool-execute.js";
import { tracePreview } from "../turn/trace/sinks/jsonl.js";
import { emitTurnBus } from "../turn/events/bus.js";
import { askAgent, forgetWorkerQuestions } from "./worker-questions.js";
import { accounts, agents, conversations, delegations, members, messages, runs, workerTranscripts } from "../db/schema.js";
import { repairToolInput } from "../turn/tools/repair-input.js";
import {
  LOOK_ONLY_NUDGE_AFTER,
  LOOK_ONLY_NUDGES_BEFORE_STOP,
  SINGLE_CALL_NUDGE_AFTER,
  SINGLE_CALL_NUDGES_MAX,
  SINGLE_CALL_NUDGE_GAP,
  WORKER_SEGMENT_STEPS,
  WORKER_STEP_CEILING,
  WORKER_WALL_MS,
  WRAP_UP_WARNING_STEPS,
  collapseOldSteps,
  compactTranscript,
  withoutImages,
  STALE_VIEWS_AT,
  affordableTokens,
  WORKER_RUN_INPUT_TOKENS,
  BUDGET_WARN_SHARE,
  STEP_INPUT_ALARM,
  STEP_ALARM_AFTER,
  workerOutputCap,
  MIN_OUTPUT_TOKENS,
  WORKER_OUTPUT_TOKENS,
  dropStaleViews,
  compactionThreshold,
  estimateTokens,
  StuckWatch,
  isLookOnlyStep,
  isSingleSmallCallStep,
  resumableTranscript,
  transcriptForStorage,
  splitForSummary,
  SUMMARY_KEEP_RECENT_TOKENS,
  withStateSummary,
  cutKind,
} from "./worker-loop.js";
import { RoomCapacityError } from "./rooms.js";
import { logger, noted } from "../log/logger.js";

/** Visible teammates from hire_subagent (hidden background workers do not count). */
export const MAX_TEAMMATES_PER_PARENT = 10;
/** Concurrent hidden worker rows when none are free to reuse. */
export const MAX_WORKERS_PER_PARENT = 10;
/** @deprecated Use MAX_TEAMMATES_PER_PARENT — workers use MAX_WORKERS_PER_PARENT. */
export const MAX_CHILDREN_PER_PARENT = MAX_TEAMMATES_PER_PARENT;
export const MAX_TEAM_DEPTH = 2;
export const MAX_ROOM_MEMBERS = 20;

/** Live model calls keyed by delegation so stop/redirect can cancel immediately. */
const activeWorkerRuns = new Map<string, AbortController>();
/** Notes from the agent waiting to be read by a running worker, keyed by delegation. */
const workerInboxes = new Map<string, string[]>();

/**
 * Hands a note to a worker that is running right now.
 * Why: steering used to stop the worker and start a blank one. The note is
 * read between two steps, so the worker keeps everything it has done.
 * Input: delegation id and the note. Output: false when no run is live here.
 */
export function messageRunningWorker(delegationId: string, note: string): boolean {
  if (!activeWorkerRuns.has(delegationId)) return false;
  const inbox = workerInboxes.get(delegationId) ?? [];
  inbox.push(note);
  workerInboxes.set(delegationId, inbox);
  return true;
}

/** True while this process is running that delegation's model loop. */
export function isWorkerLive(delegationId: string): boolean {
  return activeWorkerRuns.has(delegationId);
}
/** Serializes free-worker allocation so parallel tool calls cannot claim one row twice. */
const workerSpawnLocks = new Map<string, Promise<void>>();

async function withWorkerSpawnLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = workerSpawnLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  workerSpawnLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (workerSpawnLocks.get(key) === current) workerSpawnLocks.delete(key);
  }
}

/** Returned when spawn_worker cannot insert or reuse a worker; tool layer maps this to { error }. */
export class WorkerCapacityError extends Error {
  readonly workers: { workerId: string; label: string; status: string }[];

  constructor(workers: { workerId: string; label: string; status: string }[], message: string) {
    super(message);
    this.name = "WorkerCapacityError";
    this.workers = workers;
  }
}

/**
 * Returns how deep an agent sits in the team tree (0 = top-level hire).
 * Why: unbounded spawn chains fork-bomb the room and blow the prompt budget.
 * Input: store, account id, agent id. Output: depth number.
 */
export async function teamDepth(store: Store, accountId: string, agentId: string): Promise<number> {
  let depth = 0;
  let current: string | null = agentId;
  while (current) {
    const [row] = await store
      .select({ parentId: agents.parentId })
      .from(agents)
      .where(and(eq(agents.id, current), eq(agents.accountId, accountId)));
    if (!row?.parentId) break;
    depth += 1;
    current = row.parentId;
    if (depth > MAX_TEAM_DEPTH) break;
  }
  return depth;
}

/**
 * Creates a child specialist owned by the calling agent.
 * Why: chief-of-staff pattern — coordinator hires specialists instead of
 * forcing the user to hire+mention each one. Child inherits provider/model
 * unless overridden, joins the same room so handoffs stay visible.
 * Input: store, account/room/caller ids, label/description/provider/modelId.
 * Output: the child agent + membership row. Throws on caps or room-full.
 */
/**
 * Creates a child specialist owned by the calling agent.
 * Why: chief-of-staff pattern — coordinator hires specialists instead of
 * forcing the user to hire+mention each one. Child inherits provider/model
 * unless overridden, joins the same room so handoffs stay visible.
 * Input: store, account/room/caller ids, label/role/personality/job (+provider/model).
 * Output: the child agent + membership row. Throws on caps or room-full.
 */
export async function hireSubagent(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; teamId?: string } & {
    label: string;
    role: string;
    personality?: string;
    jobDescription: string;
    provider?: string;
    modelId?: string;
  },
) {
  const data = subagentCreateSchema.parse({
    label: input.label,
    role: input.role,
    personality: input.personality,
    jobDescription: input.jobDescription,
    provider: input.provider,
    modelId: input.modelId,
  });
  const [parent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if (!parent) throw new Error("Parent agent not found.");
  const depth = await teamDepth(store, input.accountId, input.parentAgentId);
  if (depth >= MAX_TEAM_DEPTH) throw new Error("Subagents cannot hire their own subagents beyond depth 2.");
  const [teammateCount] = await store
    .select({ value: count() })
    .from(agents)
    .where(
      and(eq(agents.parentId, input.parentAgentId), eq(agents.accountId, input.accountId), eq(agents.hidden, false)),
    );
  if ((teammateCount?.value ?? 0) >= MAX_TEAMMATES_PER_PARENT) {
    throw new Error(`This agent already has ${MAX_TEAMMATES_PER_PARENT} teammates. Background workers do not count toward that cap.`);
  }
  const [room] = await store
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found.");
  // Room integrity (Phase 15): a private chat stays 1:1 — nobody is ever
  // added to it, by tool or otherwise. Teams form in groups the agent creates
  // with create_group. The message names the way out instead of just refusing.
  if (room.kind === "direct") {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const existing = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  if (existing.length >= MAX_ROOM_MEMBERS) throw new RoomCapacityError();

  const baseName = data.label.trim().replace(/\s+/g, "-").slice(0, 60) || "subagent";
  const surprise = randomSurpriseMark();
  const provider = data.provider ?? parent.provider;
  const modelId = data.modelId ?? parent.modelId;
  const modelContextWindow = await resolveGatewayContextWindow(provider, modelId);
  const [child] = await store
    .insert(agents)
    .values({
      accountId: input.accountId,
      name: `${baseName}-${Math.random().toString(36).slice(2, 6)}`,
      label: data.label,
      role: data.role,
      personality: data.personality ?? "",
      jobDescription: data.jobDescription,
      provider,
      modelId,
      modelContextWindow,
      parentId: input.parentAgentId,
      teamId: input.teamId ?? parent.teamId ?? parent.id,
      markShape: surprise.markShape,
      markColor: surprise.markColor,
      markMaterial: surprise.markMaterial,
      markStyle: surprise.markStyle,
      markGender: surprise.markGender,
    })
    .returning();
  if (!child) throw new Error("Subagent insert returned no row.");
  await store.insert(members).values({ conversationId: input.conversationId, accountId: input.accountId, agentId: child.id });
  return child;
}

/**
 * Records a delegation from parent to an existing team agent.
 * Why: attribution table lets the UI show "via @chief" and lets audits trace
 * who asked for what; status flips to done/failed by the turn runner.
 * Input: store, account/room/parent ids, child agentId, task text.
 * Output: delegation row. Throws when child is outside account or self.
 */
export async function recordDelegation(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; agentId: string; task: string },
) {
  const data = delegateSchema.parse({ agentId: input.agentId, task: input.task });
  if (data.agentId === input.parentAgentId) throw new Error("An agent cannot delegate to itself.");
  const [child] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, input.accountId)));
  if (!child) throw new Error("Delegate target is not on this account.");
  const [membership] = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.conversationId, input.conversationId),
        eq(members.accountId, input.accountId),
        eq(members.agentId, data.agentId),
      ),
    );
  if (!membership) throw new Error("Delegate target is not in this room.");
  const [row] = await store
    .insert(delegations)
    .values({
      accountId: input.accountId,
      parentAgentId: input.parentAgentId,
      childAgentId: data.agentId,
      conversationId: input.conversationId,
      task: data.task,
      status: "running",
    })
    .returning();
  if (!row) throw new Error("Delegation insert returned no row.");
  return row;
}

/**
 * Lists agents sharing the caller's team (same teamId or direct children).
 * Why: the model needs a small roster to choose delegates without dumping
 * the whole account roster into the prompt. Role rides along so the CMO
 * picks the social manager vs the researcher by job, not just name.
 * Input: store, account id, agent id. Output: team agents (id, name, label, role).
 */
export async function listTeam(store: Store, accountId: string, agentId: string) {
  const [self] = await store
    .select({ teamId: agents.teamId, id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!self) return [];
  if (!self.teamId) {
    return store
      .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
      .from(agents)
      .where(
        and(eq(agents.parentId, agentId), eq(agents.accountId, accountId), eq(agents.hidden, false)),
      );
  }
  return store
    .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
    .from(agents)
    .where(and(eq(agents.teamId, self.teamId), eq(agents.accountId, accountId), eq(agents.hidden, false)));
}

/**
 * Adds an existing account agent to a group room (model-callable).
 * Why: teams grow after creation — CMO hires a designer next week without a
 * human console step. Group-only by construction: direct rooms throw the same
 * 1:1 message as hire/add paths, so no tool can ever touch a private chat.
 * Input: store, account/room/agent ids. Output: the membership row.
 */
export async function addGroupMember(
  store: Store,
  input: { accountId: string; conversationId: string; agentId: string },
) {
  const [room] = await store
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found.");
  if (room.kind === "direct") {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const [agent] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.accountId, input.accountId)));
  if (!agent) throw new Error("Unknown agent id — invite only agents on this account.");
  const existing = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  if (existing.some((row) => row.agentId === input.agentId)) return { agentId: input.agentId };
  if (existing.length >= MAX_ROOM_MEMBERS) throw new RoomCapacityError();
  const [row] = await store
    .insert(members)
    .values({ conversationId: input.conversationId, accountId: input.accountId, agentId: input.agentId })
    .returning();
  if (!row) throw new Error("The member insert returned no row.");
  return row;
}

const WORKER_RESULT_MAX = 20_000;
/** Cap per preloaded skill body so one long playbook cannot dominate every worker step. */
const PRELOADED_SKILL_CHARS = 8_000;
// All preloaded skills together; every worker step resends them.
const PRELOADED_SKILLS_TOTAL_CHARS = 16_000;
/**
 * The other installed skills, listed for a worker; smaller than the chat list since a worker resends it every step.
 * A worker is on one job: names with a short line are enough, and `list_skills` finds the rest.
 */
const WORKER_CATALOG_TOKENS = 600;
/** One cheap text-only pass when a worker spent its budget on tools and wrote nothing. No tools attached. */
const workerReportRetryInstructions = (): string => prompt("worker-rules", "report-retry");
export const WORKER_STALE_MS = 4 * 60 * 60 * 1000;

async function latestDelegationStatus(
  store: Store,
  accountId: string,
  workerId: string,
): Promise<"running" | "done" | "failed" | "none"> {
  const [row] = await store
    .select({ status: delegations.status })
    .from(delegations)
    .where(and(eq(delegations.childAgentId, workerId), eq(delegations.accountId, accountId)))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) return "none";
  return row.status as "running" | "done" | "failed";
}

/** Free worker = hidden child whose latest delegation is not running (done, failed, or never run). */
async function findFreeHiddenWorker(store: Store, accountId: string, parentAgentId: string) {
  const hidden = await store
    .select({ id: agents.id, createdAt: agents.createdAt })
    .from(agents)
    .where(and(eq(agents.parentId, parentAgentId), eq(agents.accountId, accountId), eq(agents.hidden, true)))
    .orderBy(agents.createdAt);
  for (const row of hidden) {
    const status = await latestDelegationStatus(store, accountId, row.id);
    if (status !== "running") return row.id;
  }
  return null;
}

async function workerCapacitySnapshot(store: Store, accountId: string, parentAgentId: string) {
  const hidden = await store
    .select({ id: agents.id, label: agents.label })
    .from(agents)
    .where(and(eq(agents.parentId, parentAgentId), eq(agents.accountId, accountId), eq(agents.hidden, true)));
  const workers: { workerId: string; label: string; status: string }[] = [];
  for (const child of hidden) {
    const status = await latestDelegationStatus(store, accountId, child.id);
    workers.push({ workerId: child.id, label: child.label, status });
  }
  return workers;
}

async function throwWorkerCapacity(store: Store, accountId: string, parentAgentId: string): Promise<never> {
  const workers = await workerCapacitySnapshot(store, accountId, parentAgentId);
  const ids = workers.map((w) => `${w.workerId} (${w.label}, ${w.status})`).join("; ");
  throw new WorkerCapacityError(
    workers,
    `Worker limit (${MAX_WORKERS_PER_PARENT}) reached and every hidden worker is still running. ` +
      `Do not call spawn_worker again this turn — running results arrive on their own. Use stop_worker on a wedged id to free a slot. ` +
      `Finished workers are reused automatically on the next spawn_worker. Current worker ids: ${ids || "(none)"}`,
  );
}

async function assignWorkerRow(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childAgentId: string;
    task: string;
    label: string;
    role: string;
    personality: string;
    jobDescription: string;
    provider: string;
    modelId: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  const modelContextWindow = await resolveGatewayContextWindow(input.provider, input.modelId);
  await store
    .update(agents)
    .set({
      label: input.label,
      role: input.role,
      personality: input.personality,
      jobDescription: input.jobDescription,
      provider: input.provider,
      modelId: input.modelId,
      modelContextWindow,
    })
    .where(and(eq(agents.id, input.childAgentId), eq(agents.accountId, input.accountId)));
  return startWorkerDelegation(store, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    parentAgentId: input.parentAgentId,
    childAgentId: input.childAgentId,
    task: input.task,
  });
}

async function startWorkerDelegation(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childAgentId: string;
    task: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  const [row] = await store
    .insert(delegations)
    .values({
      accountId: input.accountId,
      parentAgentId: input.parentAgentId,
      childAgentId: input.childAgentId,
      conversationId: input.conversationId,
      task: input.task,
      status: "running",
      progress: "Queued.",
    })
    .returning();
  if (!row) throw new Error("Delegation insert returned no row.");
  return { workerId: input.childAgentId, delegationId: row.id, status: "running" };
}

/**
 * Spawns an ephemeral background worker for the calling agent.
 * Why: the parent stays chatty while long work runs privately — the user can
 * keep asking things and gets a process id instead of silence. Hidden from
 * the roster and NOT a room member: its only output is the delegation result
 * the parent summarizes. Returns immediately; the work runs detached.
 * Input: store, account/room/caller ids, label/role/personality/job/task (+provider/model).
 * Output: {workerId, delegationId, status:"running"}. The run starts detached.
 */
export async function spawnWorker(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string } & {
    label: string;
    role: string;
    personality?: string;
    jobDescription: string;
    task: string;
    kind?: WorkerKind;
    instructions?: string;
    maxSteps?: number;
    provider?: string;
    modelId?: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  const data = spawnWorkerInputSchema.parse({
    label: input.label,
    role: input.role,
    personality: input.personality,
    jobDescription: input.jobDescription,
    task: input.task,
    kind: input.kind,
    instructions: input.instructions,
    maxSteps: input.maxSteps,
    provider: input.provider,
    modelId: input.modelId,
  });
  const [parent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if (!parent) throw new Error("Parent agent not found.");
  const depth = await teamDepth(store, input.accountId, input.parentAgentId);
  if (depth >= MAX_TEAM_DEPTH) throw new Error("Subagents cannot spawn their own workers beyond depth 2.");

  const packedJob = packWorkerJobDescription({
    kind: data.kind,
    jobDescription: data.jobDescription,
    instructions: data.instructions,
  });

  const workerMeta = {
    label: data.label,
    role: data.role,
    personality: data.personality ?? "",
    jobDescription: packedJob,
    provider: data.provider ?? parent.provider,
    modelId: data.modelId ?? parent.modelId,
  };

  return withWorkerSpawnLock(`${input.accountId}:${input.parentAgentId}`, async () => {
    const freeId = await findFreeHiddenWorker(store, input.accountId, input.parentAgentId);
    if (freeId) {
      return assignWorkerRow(store, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        parentAgentId: input.parentAgentId,
        childAgentId: freeId,
        task: data.task,
        ...workerMeta,
      });
    }

    const [workerCount] = await store
      .select({ value: count() })
      .from(agents)
      .where(
        and(eq(agents.parentId, input.parentAgentId), eq(agents.accountId, input.accountId), eq(agents.hidden, true)),
      );
    if ((workerCount?.value ?? 0) >= MAX_WORKERS_PER_PARENT) {
      await throwWorkerCapacity(store, input.accountId, input.parentAgentId);
    }

    const baseName = data.label.trim().replace(/\s+/g, "-").slice(0, 60) || "worker";
    const surprise = randomSurpriseMark();
    const provider = workerMeta.provider;
    const modelId = workerMeta.modelId;
    const modelContextWindow = await resolveGatewayContextWindow(provider, modelId);
    const [child] = await store
      .insert(agents)
      .values({
        accountId: input.accountId,
        name: `${baseName}-${Math.random().toString(36).slice(2, 6)}`,
        label: data.label,
        role: data.role,
        personality: data.personality ?? "",
        jobDescription: packedJob,
        provider,
        modelId,
        modelContextWindow,
        parentId: input.parentAgentId,
        teamId: parent.teamId ?? parent.id,
        hidden: true,
        markShape: surprise.markShape,
        markColor: surprise.markColor,
        markMaterial: surprise.markMaterial,
        markStyle: surprise.markStyle,
        markGender: surprise.markGender,
      })
      .returning();
    if (!child) throw new Error("Worker insert returned no row.");
    // NOTE: no members insert — workers are never room members. Room 1:1
    // integrity holds structurally, and group threads stay free of worker noise.
    return startWorkerDelegation(store, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentAgentId: input.parentAgentId,
      childAgentId: child.id,
      task: data.task,
    });
  });
}

/**
 * Starts a new piece of work on one specific worker, continuing its last conversation.
 * Why: a follow-up belongs to the worker that already knows the job. Picking
 * any free worker row, as spawn does, would hand it to one that knows nothing.
 * Input: store, ids, the worker to continue, and the follow-up text.
 * Output: the new delegation plus the delegation whose conversation it continues (null when none was saved).
 */
export async function continueWorker(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; workerId: string; task: string },
): Promise<{ workerId: string; delegationId: string; status: "running"; resumeFrom: string | null }> {
  const id = workerRefSchema.parse({ workerId: input.workerId }).workerId;
  return withWorkerSpawnLock(`${input.accountId}:${input.parentAgentId}`, async () => {
    const [worker] = await store
      .select({ id: agents.id, parentId: agents.parentId })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.accountId, input.accountId), eq(agents.hidden, true)));
    if (!worker || worker.parentId !== input.parentAgentId) throw new Error("That worker does not belong to you.");
    if ((await latestDelegationStatus(store, input.accountId, id)) === "running") {
      throw new Error("That worker is still running. Send it a note instead of starting it again.");
    }
    const [saved] = await store
      .select({ delegationId: workerTranscripts.delegationId })
      .from(workerTranscripts)
      .where(and(eq(workerTranscripts.childAgentId, id), eq(workerTranscripts.accountId, input.accountId)))
      .orderBy(desc(workerTranscripts.updatedAt))
      .limit(1);
    const started = await startWorkerDelegation(store, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentAgentId: input.parentAgentId,
      childAgentId: id,
      task: input.task,
    });
    return { ...started, resumeFrom: saved?.delegationId ?? null };
  });
}

/** A paused worker's progress line; check_worker reads it back as `waitingOnApproval`. */
const PAUSED_FOR_APPROVAL = "Paused: waiting for the person to approve an action.";

/** Last few things a worker did, and the calls that failed, read from its saved conversation. */
function recentActions(saved: unknown[], limit = 6): string[] {
  const actions: string[] = [];
  for (const message of saved) {
    const msg = message as { role?: string; content?: unknown } | null;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as { type?: string; toolName?: string; input?: unknown }[]) {
        if (part.type !== "tool-call") continue;
        let detail = "";
        try {
          detail = JSON.stringify(part.input ?? {}).replace(/\s+/g, " ").slice(0, 140);
        } catch {
          detail = "";
        }
        actions.push(`${part.toolName ?? "tool"} ${detail}`.trim());
      }
    } else if (msg?.role === "tool" && Array.isArray(msg.content)) {
      // A failed call is what explains a worker that seems stuck, so it is listed too.
      for (const part of msg.content as { type?: string; toolName?: string; output?: { type?: string; value?: unknown } }[]) {
        if (part.type !== "tool-result") continue;
        const value = part.output?.value;
        const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
        if (part.output?.type !== "error-text" && part.output?.type !== "error-json" && !/^(Error|The call failed)|quota|rate limit|permission denied|timed out/i.test(text)) continue;
        actions.push(`${part.toolName ?? "tool"} failed: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  }
  return actions.slice(-limit);
}

export type WorkerStatus = {
  workerId: string;
  /** `lost` = marked running but no live run behind it (the system restarted). */
  status: "running" | "done" | "failed" | "lost";
  task: string;
  startedMinutesAgo: number;
  lastActivitySecondsAgo: number;
  steps: number;
  progress: string;
  recentActions: string[];
  waitingOnApproval?: boolean;
  result?: string;
};

/**
 * What this agent's workers are doing right now, in this chat.
 * Why: an agent that cannot look says "still working" from memory, long after
 * the work stopped. This is the look: status, how long, the last things done.
 * Input: store, account, parent agent, room, and optionally one worker id.
 * Output: running workers plus the few that finished most recently.
 */
export async function workerStatuses(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; workerId?: string },
): Promise<WorkerStatus[]> {
  const rows = await store
    .select()
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, input.accountId),
        eq(delegations.parentAgentId, input.parentAgentId),
        eq(agents.hidden, true),
        ...(input.workerId
          ? [eq(delegations.childAgentId, input.workerId)]
          : [eq(delegations.conversationId, input.conversationId)]),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(12);
  const picked: typeof rows = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // One line per worker: its newest piece of work.
    if (seen.has(row.delegations.childAgentId)) continue;
    seen.add(row.delegations.childAgentId);
    if (row.delegations.status === "running" || picked.filter((item) => item.delegations.status !== "running").length < 3) {
      picked.push(row);
    }
  }
  const now = Date.now();
  const out: WorkerStatus[] = [];
  for (const { delegations: row } of picked) {
    const [saved] = await store
      .select({ messages: workerTranscripts.messages, steps: workerTranscripts.steps })
      .from(workerTranscripts)
      .where(eq(workerTranscripts.delegationId, row.id));
    const running = row.status === "running";
    out.push({
      workerId: row.childAgentId,
      status: running ? (activeWorkerRuns.has(row.id) ? "running" : "lost") : (row.status as "done" | "failed"),
      task: row.task.replace(/\s+/g, " ").trim().slice(0, 160),
      startedMinutesAgo: Math.round((now - row.createdAt.getTime()) / 60_000),
      lastActivitySecondsAgo: Math.round((now - row.heartbeatAt.getTime()) / 1_000),
      steps: saved?.steps ?? row.modelSteps ?? 0,
      progress: (row.progress ?? "").slice(0, 200),
      recentActions: recentActions(saved?.messages ?? []),
      waitingOnApproval: running && row.progress === PAUSED_FOR_APPROVAL,
      ...(running ? {} : { result: (row.result ?? "").slice(0, 900) }),
    });
  }
  return out;
}

/**
 * Reads a worker's latest delegation.
 * Why: server-side status read for capacity messages and the (non-model)
 * status path — the model never polls this; finished results arrive via
 * worker.settled → delivery, failures via parent re-wake.
 * Input: store, account id, worker agent id. Output: {status, task, result?}.
 */
export async function checkWorker(store: Store, accountId: string, workerId: string) {
  const id = workerRefSchema.parse({ workerId }).workerId;
  const [row] = await store
    .select()
    .from(delegations)
    .where(and(eq(delegations.childAgentId, id), eq(delegations.accountId, accountId)))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) throw new Error("No work found for that worker id.");
  return { workerId: id, status: row.status, task: row.task, result: row.result };
}

/**
 * Stops a worker's running delegation.
 * Why: wedged or obsolete work should die on request instead of burning
 * budget until reclaim. Marks failed with the reason; the worker becomes free
 * for reuse on the next spawn_worker. Idempotent: nothing running reads as stopped.
 * Input: store, account id, worker agent id. Output: {stopped} flag.
 */
export async function stopWorker(store: Store, accountId: string, workerId: string): Promise<{ stopped: boolean }> {
  const id = workerRefSchema.parse({ workerId }).workerId;
  const [row] = await store
    .select({ id: delegations.id })
    .from(delegations)
    .where(and(eq(delegations.childAgentId, id), eq(delegations.accountId, accountId), eq(delegations.status, "running")))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) return { stopped: false };
  const stopped = await store
    .update(delegations)
    .set({ status: "failed", result: "Stopped by the parent agent.", progress: "Stopped by manager." })
    .where(and(eq(delegations.id, row.id), eq(delegations.status, "running")))
    .returning({ id: delegations.id });
  if (stopped.length === 0) return { stopped: false };
  // The run saves its conversation as it aborts, so the work can be continued later.
  activeWorkerRuns.get(row.id)?.abort("Worker stopped by parent.");
  return { stopped: true };
}

/**
 * Reclaims workers lost to a core crash or hang.
 * Why: detached work that never reports would read "running" forever and the
 * parent would poll pointlessly. Stale threshold is generous (4h) because
 * workers legitimately run long.
 * Input: store, staleness ms. Output: the reclaimed rows.
 */
export async function reclaimStaleDelegations(store: Store, staleMs = WORKER_STALE_MS) {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await store
    .select()
    .from(delegations)
    .where(and(eq(delegations.status, "running"), lt(delegations.heartbeatAt, cutoff)));
  for (const row of stale) {
    const reclaimed = await store
      .update(delegations)
      .set({
        status: "failed",
        result: "Worker lost (core restarted or hung) and was reclaimed.",
        progress: "Reclaimed after its heartbeat stopped.",
      })
      .where(and(eq(delegations.id, row.id), eq(delegations.status, "running")))
      .returning({ id: delegations.id });
    if (reclaimed.length > 0) activeWorkerRuns.get(row.id)?.abort("Worker heartbeat expired.");
  }
  return stale;
}

export type WorkerGenerate = () => Promise<string>;

export type WorkerSettled = { workerId: string; task: string; result: string; status: "done" | "failed" };

/** How many workers one request may set going, restarts included, before the agent has to stop and tell the person. */
export const MAX_STARTS_PER_ASK = 6;

/**
 * Counts the workers this agent has started in this chat since it was last asked for something.
 * Why: a worker that ends without finishing wakes the agent, which tells the
 * person "building it now" and starts the worker again. Nothing limited that
 * round trip, so one request could produce the same message, or the same
 * file, twenty times while nobody was typing. "Asked" is the person's last
 * message or the last routine that fired, whichever is later.
 * Input: store and the account, room and agent ids. Output: the count.
 */
export async function startsSinceLastAsk(store: Store, accountId: string, conversationId: string, parentAgentId: string): Promise<number> {
  const [human] = await store
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId), isNull(messages.agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [routine] = await store
    .select({ at: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.accountId, accountId), eq(runs.kind, "routine")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  const since = Math.max(human?.at?.getTime() ?? 0, routine?.at?.getTime() ?? 0);
  const started = await store
    .select({ createdAt: delegations.createdAt })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, parentAgentId),
        // Workers only: a request to a lasting teammate is a conversation, not a restart.
        eq(agents.hidden, true),
      ),
    );
  return started.filter((row) => (row.createdAt?.getTime() ?? 0) > since).length;
}

function taskFingerprint(task: string): string {
  return task.trim().slice(0, 80).toLowerCase();
}

/**
 * Counts this parent's failed workers on the same task since the last human message.
 * Why: a new message (including "go") starts a fresh budget, and a different task
 * must not inherit failures from an unrelated job.
 * Input: store, account/room/parent ids, and the task being started.
 * Output: failed delegation count for that task fingerprint. Omit task to count every failure since the person spoke.
 */
export async function failuresSinceLastUser(
  store: Store,
  accountId: string,
  conversationId: string,
  parentAgentId: string,
  task?: string,
): Promise<number> {
  const full = await store
    .select({ agentId: messages.agentId, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const lastHuman = full.find((row) => row.agentId === null)?.createdAt ?? null;
  const failed = await store
    .select({ createdAt: delegations.createdAt, task: delegations.task })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, parentAgentId),
        eq(delegations.status, "failed"),
      ),
    );
  const sinceHuman = lastHuman
    ? failed.filter((row) => row.createdAt && row.createdAt.getTime() > lastHuman.getTime())
    : failed;
  const fingerprint = task ? taskFingerprint(task) : "";
  const scoped = fingerprint
    ? sinceHuman.filter((row) => taskFingerprint(row.task) === fingerprint)
    : sinceHuman;
  return scoped.length;
}

/**
 * Builds the hidden cue that rewakes the parent after a worker settles failed.
 * Why: the parent turn already ended, so nobody watches the delegation. Retry
 * once with a rewritten task; after 2 failures tell the person and stop.
 * Supports batched settled workers to wake the parent once instead of per-worker cascades.
 * Input: worker/task/result or array + retry flag. Output: cue string.
 */
export function workerFollowupCue(input: {
  workerId?: string;
  task?: string;
  result?: string;
  retry: boolean;
  settled?: Array<{ workerId: string; task: string; result: string }>;
}): string {
  if (input.settled && input.settled.length > 1) {
    const list = input.settled
      .map((s) =>
        prompt("cues", "worker-failed-item", {
          workerId: s.workerId,
          task: s.task.slice(0, 200),
          result: s.result.slice(0, 400),
        }),
      )
      .join("\n");
    return prompt("cues", input.retry ? "worker-failed-many-retry" : "worker-failed-many-final", { list });
  }
  return prompt("cues", input.retry ? "worker-failed-retry" : "worker-failed-final", {
    workerId: input.workerId ?? input.settled?.[0]?.workerId ?? "worker",
    task: (input.task ?? input.settled?.[0]?.task ?? "task").slice(0, 500),
    result: (input.result ?? input.settled?.[0]?.result ?? "failed").slice(0, 1000),
  });
}

/**
 * Claims a delegation's one terminal auto-delivery exactly once.
 * Why: the spawn path schedules a delayed re-wake, and restarts or retries
 * could schedule another — without a guard the room gets the same summary
 * twice. Single atomic UPDATE ... WHERE delivered=false: exactly one claimer
 * gets true, every later claim gets false.
 * Input: store, delegation id. Output: true when this caller won delivery.
 */
export async function claimDelivery(store: Store, delegationId: string): Promise<boolean> {
  const claimed = await store
    .update(delegations)
    .set({ delivered: true })
    .where(
      and(
        eq(delegations.id, delegationId),
        inArray(delegations.status, ["done", "failed"]),
        eq(delegations.delivered, false),
      ),
    )
    .returning({ id: delegations.id });
  return claimed.length > 0;
}

/**
 * Checks whether a worker result already reached the room in the parent's voice.
 * Why: the auto-delivery re-wake races a person asking "any update?" — the
 * parent then summarizes from history in a live turn, and the delayed
 * auto-post would repeat it. Distinctive-head match on recent parent bubbles
 * catches the common double without a migration or fuzzy search.
 * Input: store, account/room/parent ids, worker result. Output: true when the
 * head of the result already appears in a recent parent message.
 */
export async function alreadyDelivered(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; result: string },
): Promise<boolean> {
  const head = input.result.trim().slice(0, 80);
  if (head.length < 20) return false;
  const recent = await store
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        eq(messages.accountId, input.accountId),
        eq(messages.agentId, input.parentAgentId),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return recent.some((row) => row.body.includes(head));
}

/**
 * Runs one worker to completion in the background (never throws).
 * Why: detached from any HTTP request or turn — the parent got its process
 * id at spawn and is re-woken on settle. Isolated brief only: standing method
 * plus the task, never the parent's thread — the parent keeps all context and
 * decides with the worker's reported proof. Restricted tools
 * (files/shell/desktop/web/history/skills, no voice/team/notify) so workers
 * cannot recurse or contact the user. Result lands truncated on the
 * delegation row for the parent to summarize.
 * Input: db, ids, task, skills root, optional stub generate (tests).
 * Output: nothing (all outcomes recorded). Never rejects.
 */
/**
 * The model one worker run uses, with its key.
 * Why: background work is where nearly all tokens go, so an account can name
 * a cheaper model for it. A cheap model whose key was removed since falls back
 * to the worker's own model instead of failing the job.
 * Input: db, account id, the worker row. Output: provider, model id, context window and key.
 */
/** The model background work runs on: the account's background model, else the agent's own. */
export async function backgroundModelFor(
  db: ReturnType<typeof getDb>,
  accountId: string,
  child: { provider: string; modelId: string; modelContextWindow: number | null },
) {
  const [row] = await db
    .select({ provider: accounts.cheapProvider, modelId: accounts.cheapModelId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (row?.provider && row.modelId) {
    const credential = await keyFor(db, accountId, row.provider).catch(() => null);
    if (credential) {
      const contextWindow = await resolveGatewayContextWindow(row.provider, row.modelId).catch(() => null);
      return { provider: row.provider, modelId: row.modelId, contextWindow, credential };
    }
  }
  return {
    provider: child.provider,
    modelId: child.modelId,
    contextWindow: child.modelContextWindow,
    credential: await keyFor(db, accountId, child.provider),
  };
}

export async function runWorker(
  db: ReturnType<typeof getDb>,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    /** Kept for callers that still pass it; a worker now runs until the job is done. */
    maxSteps?: number;
    /** Delegation whose saved conversation this run continues from. */
    resumeFrom?: string;
    /** Replaces the usual task message when continuing (a restart note, an approval). */
    resumeNote?: string;
    /** Skill names whose bodies are placed in the worker's prompt up front. */
    skills?: string[];
    /** Background lines appended to the task the worker reads (not stored as the task). */
    context?: string;
    /** Stop once with a preview before the costly part. Left out, a named skill can ask for it; false never (scheduled runs). */
    checkpoint?: boolean;
    /** Most input tokens (cached or not) this run may send before it must report. Left out: WORKER_RUN_INPUT_TOKENS. */
    tokenBudget?: number;
    generate?: WorkerGenerate;
    onSettled?: (settled: WorkerSettled) => void;
  },
): Promise<void> {
  const controller = new AbortController();
  activeWorkerRuns.set(input.delegationId, controller);
  type Usage = {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    reasoningTokens?: number | null;
    modelSteps?: number;
  };
  const finish = async (status: "done" | "failed", result: string, usage?: Usage): Promise<void> => {
    const { formatWorkerReport } = await import("../turn/worker-report.js");
    const fullReport = formatWorkerReport(result, status);
    const report = await compactWorkerReport(input.accountId, input.delegationId, fullReport);
    const updated = await db
      .update(delegations)
      .set({
        status,
        result: report.slice(0, WORKER_RESULT_MAX),
        progress: status === "done" ? "Completed." : "Stopped with a blocker.",
        heartbeatAt: new Date(),
        ...(usage?.inputTokens ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(usage?.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage?.modelSteps ? { modelSteps: usage.modelSteps } : {}),
      })
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
      .returning({ id: delegations.id })
      .catch(noted("Saving a worker's usage"));
    if (!Array.isArray(updated) || updated.length === 0) return;
    try {
      input.onSettled?.({ workerId: input.childId, task: input.task, result: report, status });
    } catch {
      // Listener is best-effort (scheduler re-wake); never fail the worker on it.
    }
  };
  try {
    const [delegation] = await db
      .select({ status: delegations.status })
      .from(delegations)
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.accountId, input.accountId)));
    if (!delegation || delegation.status !== "running") return;
    const [child] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.childId), eq(agents.accountId, input.accountId)));
    if (!child) {
      await finish("failed", "Worker agent is gone.");
      return;
    }
    if (input.generate) {
      await finish("done", await input.generate());
      return;
    }
    // Out of credit a moment ago: failing now costs nothing, failing after ten steps costs ten steps.
    if (creditOutage(input.accountId)) {
      await finish("failed", new OutOfCreditError().message);
      return;
    }
    // The day's spending limit is reached: background work waits for tomorrow or a higher limit.
    const budgetAtStart = await budgetState(db, input.accountId).catch(() => null);
    if (budgetAtStart?.reached) {
      await warnAboutBudget(db, input.accountId, input.conversationId, budgetAtStart).catch(noted("Warning about the daily limit"));
      await finish("failed", budgetReachedMessage(budgetAtStart));
      return;
    }
    // The person's computer is the chatting agent's screen. A hidden worker
    // must drive that same desktop, or Chrome opens on a screen they cannot see.
    const [parent] = await db
      .select({ linuxProfile: agents.linuxProfile })
      .from(agents)
      .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
    let profile: string | null = parent?.linuxProfile ?? null;
    try {
      // Always re-ensure the profile: durable accounts may still be running an
      // older container created before toolchain/admin provisioning existed.
      profile = await createProfile(db, input.accountId, input.parentAgentId);
    } catch {
      // Read/search-only workers can still proceed if computer repair failed.
    }
    // Isolated brief: the worker gets its standing method (preamble), a
    // one-line role, and the task — nothing else. No parent identity, no
    // thread history: anything the worker needs must be in the brief. The
    // parent keeps all context and decides with the worker's reported proof.
    // The account's cheap model, when set, runs all background work; otherwise the worker's own.
    const runOn = await backgroundModelFor(db, input.accountId, child);
    const credential = runOn.credential;
    // Recorded for the usage page, which counts tokens per model.
    await db
      .update(delegations)
      .set({ provider: runOn.provider, modelId: runOn.modelId })
      .where(eq(delegations.id, input.delegationId))
      .catch(noted("Saving a worker's model"));
    const review: ToolContext = {
      db,
      store: db,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.childId,
      runId: input.delegationId,
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async (event) => {
        try {
          const row = await appendEvent(db, {
            accountId: input.accountId,
            conversationId: input.conversationId,
            runId: null,
            event,
          });
          publish(input.accountId, input.conversationId, { ...event, cursor: row.id });
        } catch {
          publish(input.accountId, input.conversationId, event);
        }
      },
      linuxProfile: profile,
      voiceAgentId: input.parentAgentId,
      // Plugins, the browser and the desktop start as one "load" tool each; the worker loads only what the job needs.
      enabledToolSets: new Set<string>(),
      pluginGates: new Map<string, string>(),
      pluginLoaders: new Map<string, string>(),
      lazyEveryPlugin: true,
      waitOnApproval: {
        signal: controller.signal,
        onState: async (state) => {
          await db
            .update(delegations)
            .set({
              heartbeatAt: new Date(),
              ...(state === "waiting" ? { progress: PAUSED_FOR_APPROVAL } : {}),
              ...(state === "resumed" ? { progress: "Working." } : {}),
            })
            .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
            .catch(noted("Saving a worker's heartbeat"));
        },
      },
    };
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, modelSteps: 0 };
    // A text-only model gets pictures as words, from a model of the account that can see.
    const capabilities = await modelCapabilities(runOn.provider, runOn.modelId).catch(() => ({ vision: null, maxOutputTokens: null }));
    /** Output limit per step; raised when steps are cut off, lowered when credit is short. */
    let outputCap = workerOutputCap(capabilities.maxOutputTokens);
    const vision = {
      canSee: capabilities.vision !== false,
      describe: null as ImageDescriber | null,
    };
    const [parentModel] = await db
      .select({ provider: agents.provider, modelId: agents.modelId })
      .from(agents)
      .where(eq(agents.id, input.parentAgentId));
    vision.describe = await imageDescriber(db, input.accountId, parentModel ? [parentModel] : [], (spent) => {
      usage.inputTokens = (usage.inputTokens ?? 0) + spent.inputTokens;
      usage.outputTokens = (usage.outputTokens ?? 0) + spent.outputTokens;
    }).catch(() => null);
    const tools = buildWorkerToolSet({
      db,
      accountId: input.accountId,
      vision: { canSee: () => vision.canSee, describe: vision.describe },
      conversationId: input.conversationId,
      profile,
      skillsRoot: input.skillsRoot,
      review,
      kind: unpackWorkerJobDescription(child.jobDescription).kind,
      // A stub run (tests) has no agent turn behind it to answer.
      ask: input.generate
        ? undefined
        : (question) =>
            askAgent(input.delegationId, question, (asked) =>
              emitTurnBus({
                type: "worker.asks",
                accountId: input.accountId,
                conversationId: input.conversationId,
                parentAgentId: input.parentAgentId,
                workerId: input.childId,
                task: input.task,
                skillsRoot: input.skillsRoot,
                ...asked,
              }),
            ),
    });
    if (profile) {
      await appendMcpTools(review, tools as Record<string, unknown>, (name, execute) =>
        wrapToolExecute(review, "worker", name, execute),
      );
    }
    const roleLine = prompt("worker-rules", "role-line", { label: child.label, role: child.role });
    const kindMeta = unpackWorkerJobDescription(child.jobDescription);
    const jobText = [input.task, input.context ?? ""].join("\n");
    const screenOn = gateToolFamilies(tools, review, startingFamilies(kindMeta.kind, jobText));
    startNamedPlugins(review, jobText);
    const home = profile ? accountHome(input.accountId, profile) : "";
    // Continuing: the same worker picks its earlier conversation back up, so
    // it keeps what it read, built and learned instead of rediscovering it.
    let prior: ModelMessage[] = [];
    let meta: { skills?: string[]; context?: string } = { skills: input.skills ?? [], context: input.context };
    if (input.resumeFrom) {
      const [saved] = await db
        .select({ messages: workerTranscripts.messages, meta: workerTranscripts.meta })
        .from(workerTranscripts)
        .where(and(eq(workerTranscripts.delegationId, input.resumeFrom), eq(workerTranscripts.accountId, input.accountId)));
      if (saved) {
        prior = resumableTranscript(saved.messages);
        meta = {
          skills: input.skills && input.skills.length > 0 ? input.skills : (saved.meta?.skills ?? []),
          context: input.context ?? saved.meta?.context,
        };
      }
    }
    const standing = [
      workerPreambleFor(kindMeta.kind, kindMeta.instructions),
      // How to work a page or the desktop, only for a job that starts with those tools; a load hands it over later.
      screenOn.size > 0 ? prompt("worker-rules", "screen-guide") : "",
      home ? prompt("worker-rules", "workspace", { home }) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // Worker runs were a black box: dispatcher steps land in the trace log but
    // worker steps never did. Emit a worker session so failures and loops are
    // debuggable the same way (and a future transcript view can read them).
    const { ensureTracePlugins } = await import("../turn/trace/bootstrap.js");
    const { createTraceSession } = await import("../turn/trace/plugins.js");
    const { randomUUID: workerTraceUuid } = await import("node:crypto");
    ensureTracePlugins();
    const workerTrace = createTraceSession({
      traceId: workerTraceUuid(),
      runId: input.delegationId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.childId,
      mode: "worker",
      provider: runOn.provider,
      modelId: runOn.modelId,
      delegationId: input.delegationId,
    });
    // Named skills ride in the prompt: the parent no longer reads them first,
    // and the worker does not spend a step (and a full resend) fetching them.
    const preloaded: string[] = [];
    /** Skills named for this job that did not fit in the prompt; the worker is told to read them itself. */
    const notLoaded: string[] = [];
    let preloadBudget = PRELOADED_SKILLS_TOTAL_CHARS;
    for (const name of (meta.skills ?? []).slice(0, 5)) {
      if (preloadBudget < 2_000) {
        notLoaded.push(name);
        continue;
      }
      try {
        const body = await readSkillForAgent(
          { skillsRoot: input.skillsRoot, accountId: input.accountId, linuxProfile: profile },
          name,
        );
        const limit = Math.min(PRELOADED_SKILL_CHARS, preloadBudget);
        // A skill cut short must say so. Cut silently, the worker believed it
        // had the whole procedure and built from the first half of it. It is
        // cut where a section starts, and the sections left out are named.
        const excerpt = skillExcerpt(body, limit);
        const directory = skillDirectoryOf(body);
        const clipped =
          excerpt.omitted.length > 0 || excerpt.text.length < body.trimEnd().length
            ? `${excerpt.text}\n\n${prompt("worker-rules", directory ? "skill-cut" : "skill-cut-no-file", {
                name,
                file: directory ? `${directory}/SKILL.md` : "",
                sections: excerpt.omitted.length > 0 ? excerpt.omitted.map((title) => `"${title}"`).join(", ") : "the rest of the file",
              })}`
            : body;
        preloadBudget -= excerpt.text.length;
        preloaded.push(prompt("worker-rules", "preloaded-skill", { name, body: clipped }));
      } catch {
        // Unknown skill name: the worker can still look it up with read_skill.
      }
    }
    if (notLoaded.length > 0) {
      preloaded.push(prompt("worker-rules", "skills-not-loaded", { names: notLoaded.map((name) => `\`${name}\``).join(", ") }));
    }
    // The rest of the installed skills, as names and short descriptions only.
    // Why: a worker knew only the skills its lead named, so when the job turned
    // out to need another (a press-and-hold check, a file type) it rebuilt the
    // method by hand over dozens of steps. It loads one with read_skill when needed.
    const named = new Set(meta.skills ?? []);
    const installed = await skillCatalogForAgent({ skillsRoot: input.skillsRoot, accountId: input.accountId, linuxProfile: profile }).catch(() => []);
    const others = installed.filter((skill) => !named.has(skill.name));
    // A preview before the costly part: when the agent asks for one, or a skill of this job does.
    // Why: a 60-second video was rendered whole, 150 steps at a time, and only then
    // seen; a wrong direction cost the full job and a restart instead of a few stills.
    if (input.checkpoint === true || (input.checkpoint !== false && installed.some((skill) => named.has(skill.name) && skill.checkpoint))) {
      preloaded.push(prompt("worker-rules", "checkpoint"));
    }
    // Only the product's skills and this agent's own by name; the rest of the account's are a search away.
    const relevant = skillsForAgent(others, new Set<string>());
    if (relevant.shown.length > 0 || relevant.hidden > 0) {
      preloaded.push(
        prompt("worker-rules", "skill-catalog", {
          catalog:
            budgetedCatalog(relevant.shown, {
              budgetTokens: Math.min(WORKER_CATALOG_TOKENS, catalogBudgetTokens(runOn.contextWindow)),
            }) + hiddenSkillsLine(relevant.hidden),
        }),
      );
    }
    // The task is sent once, as the user message; the system text is standing method only.
    // Written once, before the first step, so the instructions stay the same (and cached) for the whole run.
    const deferred = deferredToolsBlock(
      review.pluginGates ?? new Map(),
      review.pluginLoaders ?? new Map(),
      review.enabledToolSets ?? new Set(),
      [input.task, ...(meta.skills ?? [])].join("\n"),
    );
    const workerInstructions = [standing, roleLine, ...preloaded, deferred].filter(Boolean).join("\n\n");
    const contextLines = meta.context?.trim() ? `\n${meta.context.trim()}` : "";
    const taskMessage = (
      input.resumeNote ??
      (prior.length > 0
        ? prompt("worker-rules", "continue-message", { task: input.task, context: contextLines })
        : prompt("worker-rules", "task-message", { task: input.task, context: contextLines }))
    ).trim();
    let transcript: ModelMessage[] = [...prior, { role: "user", content: taskMessage }];
    let totalSteps = 0;
    const saveTranscript = async (): Promise<void> => {
      const stored = transcriptForStorage(transcript);
      await db
        .insert(workerTranscripts)
        .values({
          delegationId: input.delegationId,
          accountId: input.accountId,
          childAgentId: input.childId,
          messages: stored,
          steps: totalSteps,
          meta,
        })
        .onConflictDoUpdate({
          target: workerTranscripts.delegationId,
          set: { messages: stored, steps: totalSteps, meta, updatedAt: new Date() },
        })
        .catch(noted("Saving a worker's transcript"));
    };
    await saveTranscript();
    await db
      .update(delegations)
      .set({ progress: prior.length > 0 ? "Continuing." : "Working.", heartbeatAt: new Date() })
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")));
    await workerTrace.emit({
      type: "run.start",
      prefix: workerInstructions,
      tail: input.task,
      promptCacheKey: `${input.accountId}:${input.childId}`,
      toolNames: Object.keys(tools).sort(),
      instructions: [{ role: "system" as const, content: workerInstructions }],
      modelMessages: [{ role: "user", content: taskMessage }],
    });
    const {
      REPORT_MARKERS,
      NEXT_STEP_NARRATION,
      claimedWrittenPaths,
      collectWorkerFallback,
      collectWorkerText,
      isToolDigestFallback,
      resolveWorkerEnding,
    } = await import("../turn/worker-report.js");
    const model = getModel(runOn.provider, runOn.modelId, credential.apiKey, credential.baseUrl);
    // Cache hints, fixed for the whole run so every step and summary reads the same cached prefix.
    const instructions = [cachedSystem(runOn.provider, workerInstructions)];
    const providerOptions = openAiCacheOptions(runOn.provider, credential.baseUrl, promptCacheKey(input.accountId, input.childId));
    const compactAt = compactionThreshold(runOn.contextWindow);
    /**
     * Replaces the older steps with a state summary the worker's own model writes.
     * Why: cutting old results made workers forget what they had read and read it
     * again for a hundred steps. The request repeats the conversation as it stands,
     * so the provider reads it from its cache. Output: false when no summary came.
     */
    const summarizeState = async (): Promise<boolean> => {
      const parts = splitForSummary(transcript);
      if (!parts) return false;
      const reply = await generateText({
        model,
        abortSignal: controller.signal,
        instructions,
        providerOptions,
        messages: [...transcript, { role: "user", content: prompt("worker-rules", "state-summary") }],
        tools,
        activeTools: activeWorkerTools(Object.keys(tools), review.enabledToolSets ?? new Set(), {
          gates: review.pluginGates,
          loaders: review.pluginLoaders,
        }) as never,
        toolChoice: "none",
        maxOutputTokens: Math.min(outputCap, 8_000),
      }).catch((error: unknown) => {
        logger.warn({ err: error, delegationId: input.delegationId }, "worker state summary failed");
        return null;
      });
      if (reply) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (reply.usage?.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (reply.usage?.outputTokens ?? 0);
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (reply.usage?.inputTokenDetails?.cacheReadTokens ?? 0);
      }
      const summary = reply?.text?.trim() ?? "";
      if (summary.length < 200) return false;
      const before = estimateTokens(transcript);
      transcript = withStateSummary(parts, summary, review.workerTodos);
      // Earlier reads are no longer in view: reading a file again now is not a loop.
      review.loaded?.clear();
      review.readCounter?.reset();
      logger.info({ delegationId: input.delegationId, before, after: estimateTokens(transcript) }, "worker conversation summarized");
      return true;
    };
    /** The older way, kept for when no summary can be written: shorten old results, then collapse the oldest steps. */
    const trimOldSteps = (): void => {
      transcript = compactTranscript(transcript);
      if (estimateTokens(transcript) > compactAt) {
        transcript = compactTranscript(transcript, { keepRecent: 6, toolChars: 300, inputChars: 200 });
      }
      if (estimateTokens(transcript) > compactAt / 2) transcript = collapseOldSteps(transcript);
      review.loaded?.clear();
      review.readCounter?.reset();
    };
    // A continued job starts from a summary of its saved conversation plus the new note,
    // not from the whole of it. Why: one video job was continued five times, and each run
    // began at 53,000 to 92,000 tokens a step with every earlier step still in view.
    if (prior.length > 0 && estimateTokens(transcript) > SUMMARY_KEEP_RECENT_TOKENS) {
      if (!(await summarizeState()) && estimateTokens(transcript) > compactAt) trimOldSteps();
    }
    const startedAt = Date.now();
    /** Slim copies of finished steps: enough to write a report from, without holding every screenshot. */
    const stepLog: { text?: string; reasoningText?: string; toolCalls?: unknown[]; toolResults?: never[] }[] = [];
    let recentToolResults: unknown[] = [];
    let lookOnlyStreak = 0;
    let lookNudges = 0;
    let singleCallStreak = 0;
    let singleCallNudges = 0;
    let lastSingleCallNudgeAt = -SINGLE_CALL_NUDGE_GAP;
    let lastInputTokens = 0;
    let lastToolCallSignature = "";
    let duplicateCallCount = 0;
    let loopStrikes = 0;
    let loopFlag = false;
    // Trying the same thing again and again without getting anywhere: told once to change course, then the run ends.
    const stuckWatch = new StuckWatch();
    let stuckReason: string | null = null;
    let narrationNudges = 0;
    let challengedPaths = false;
    let warnedWrapUp = false;
    let cutOff = false;
    let cutOffs = 0;
    /** The step that hit the limit wrote no text and called no tool: it only thought. */
    let thoughtOnly = false;
    /** Set when this run's token budget or the account's daily limit is spent: the next step is the report. */
    let spendStop: string | null = null;
    let alarmed = false;
    let warnedBudget = false;
    const tokenBudget = input.tokenBudget ?? WORKER_RUN_INPUT_TOKENS;
    let cutShort = false;
    let finalText = "";
    /** Messages of the segment in flight, so a stop mid-segment still saves what was done. */
    let inFlight: ModelMessage[] = [];
    const missingClaimed = async (text: string): Promise<string[]> => {
      if (!profile) return [];
      const missing: string[] = [];
      for (const path of claimedWrittenPaths(text)) {
        // -e, not -f: a report often names the project folder it made.
        const check = await exec(input.accountId, ["test", "-e", path], profile).catch(() => ({ code: 1 }));
        if (check.code !== 0) missing.push(path);
      }
      return missing;
    };
    const say = (note: string): void => {
      transcript.push({ role: "user", content: note });
    };
    /**
     * Checks spending between segments. Returns the note that ends the run, or null.
     * Also raises the alarm once when steps are abnormally large: that is how
     * a plugin flooding every step would have been caught within the hour.
     */
    const spendingStop = async (): Promise<string | null> => {
      const sent = usage.inputTokens ?? 0;
      if (!alarmed && totalSteps >= STEP_ALARM_AFTER && sent / totalSteps > STEP_INPUT_ALARM) {
        alarmed = true;
        const perStep = Math.round(sent / totalSteps / 1000);
        logger.warn({ accountId: input.accountId, delegationId: input.delegationId, perStep }, "worker steps are abnormally large");
        await saveNotification(db, {
          accountId: input.accountId,
          conversationId: input.conversationId,
          title: "A background job is unusually expensive",
          body: `A job is sending about ${perStep}K tokens per step, two to three times the usual. A connected plugin or a very long brief is the usual cause. Usage shows which agent it is.`,
          urgency: "info",
        }).catch(noted("Raising the step-size alarm"));
      }
      const millions = (tokens: number): string => String(Math.round(tokens / 100_000) / 10);
      if (sent >= tokenBudget) return prompt("worker-rules", "budget-stop", { tokens: millions(sent) });
      // A warning first, so the run ends with its work saved and a report instead of mid-action.
      if (!warnedBudget && sent >= tokenBudget * BUDGET_WARN_SHARE) {
        warnedBudget = true;
        say(prompt("worker-rules", "budget-wrap-up", { tokens: millions(sent), budget: millions(tokenBudget) }));
      }
      const budget = await budgetState(db, input.accountId).catch(() => null);
      if (budget) await warnAboutBudget(db, input.accountId, input.conversationId, budget).catch(noted("Warning about the daily limit"));
      if (budget?.reached) return prompt("worker-rules", "daily-limit-stop");
      return null;
    };
    try {
      for (;;) {
        const remaining = WORKER_STEP_CEILING - totalSteps;
        const closing = remaining <= 1 || Date.now() - startedAt > WORKER_WALL_MS || loopStrikes >= 2 || spendStop !== null;
        if (closing) {
          cutShort = true;
          say(spendStop ?? prompt("worker-rules", "last-step"));
        }
        const segmentSteps = closing ? 1 : Math.min(WORKER_SEGMENT_STEPS, remaining - 1);
        let segmentCount = 0;
        inFlight = [];
        const result = await generateText({
          model,
          abortSignal: controller.signal,
          instructions,
          providerOptions,
          messages: transcript,
          tools,
          maxOutputTokens: outputCap,
          stopWhen: [
            isStepCount(segmentSteps),
            // A note from the agent, a repeat loop, or an answer cut off at the limit is handled between steps.
            () => loopFlag || cutOff || (workerInboxes.get(input.delegationId)?.length ?? 0) > 0,
          ],
          // The closing step is for the report: no tools on offer. Otherwise
          // every tool, except plugin tools the worker has not loaded.
          prepareStep: ({ messages: pending }) => ({
            activeTools: (closing
              ? []
              : activeWorkerTools(Object.keys(tools), review.enabledToolSets ?? new Set(), {
                  gates: review.pluginGates,
                  loaders: review.pluginLoaders,
                })) as never,
            // Anthropic caches only up to a marked point: mark the newest message, so
            // each step reads everything before it from the cache at a tenth of the price.
            messages: stepMessages(
              runOn.provider,
              pending.length > transcript.length && estimateTokens(pending) > STALE_VIEWS_AT ? dropStaleViews(pending) : pending,
            ),
          }),
          // One free fix for inputs that are wrong in shape but clear in meaning.
          repairToolCall: async ({ toolCall, error }) => {
            // A tool the worker has not loaded yet: it turns on for the next step instead of failing again.
            const gate = review.pluginGates?.get(toolCall.toolName);
            if (gate && NoSuchToolError.isInstance(error)) {
              review.enabledToolSets?.add(gate.startsWith("family:") ? gate : pluginToolKey(toolCall.toolName));
              return null;
            }
            const repaired = repairToolInput(toolCall.toolName, toolCall.input);
            return repaired ? { ...toolCall, input: repaired } : null;
          },
          onStepEnd: async (step) => {
            totalSteps += 1;
            segmentCount += 1;
            const cut = cutKind(step);
            if (cut) {
              cutOff = true;
              thoughtOnly = cut === "thinking";
            }
            const currentCalls = (step.toolCalls ?? []).map((call) => ({
              name: (call as { toolName?: string }).toolName ?? "",
              input: (call as { input?: unknown }).input ?? (call as { args?: unknown }).args,
            }));
            const stepMessages = (step as { response?: { messages?: unknown } }).response?.messages;
            if (Array.isArray(stepMessages)) inFlight = stepMessages as ModelMessage[];
            // The same call three times in a row returns the same thing three times.
            const callSig = JSON.stringify(currentCalls);
            if (callSig.length > 2 && callSig === lastToolCallSignature) {
              duplicateCallCount += 1;
              if (duplicateCallCount >= 2) loopFlag = true;
            } else {
              lastToolCallSignature = callSig;
              duplicateCallCount = 0;
            }
            if (currentCalls.length > 0) lookOnlyStreak = isLookOnlyStep(currentCalls) ? lookOnlyStreak + 1 : 0;
            if (currentCalls.length > 0) singleCallStreak = isSingleSmallCallStep(currentCalls) ? singleCallStreak + 1 : 0;
            stepLog.push({
              text: step.text,
              reasoningText: (step as { reasoningText?: string }).reasoningText,
              toolCalls: currentCalls.length > 0 ? currentCalls.map(() => ({})) : [],
            });
            // The next step's calls are counted from zero.
            review.stepCalls = 0;
            const results = (step as { toolResults?: unknown[] }).toolResults ?? [];
            if (results.length > 0) recentToolResults = [...recentToolResults, ...results].slice(-5);
            const stuck = stuckWatch.record(currentCalls, results);
            if (stuck && !stuckReason) {
              stuckReason = stuck;
              loopFlag = true;
            }
            const toolNames = currentCalls.map((call) => call.name).filter(Boolean).join(", ");
            // What it said it is doing, beside the tools it used: that is what the agent reads in check_worker.
            const saying = (step.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
            const checkpoint = toolNames
              ? `Step ${totalSteps}: ${toolNames}${saying ? ` — ${saying}` : ""}`
              : `Step ${totalSteps}: ${saying || "reasoning"}`;
            await db
              .update(delegations)
              .set({ progress: checkpoint, heartbeatAt: new Date() })
              .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
              .catch(noted("Saving a worker's progress"));
            lastInputTokens = step.usage?.inputTokens ?? lastInputTokens;
            // Counted per step, not per segment: a stop mid-segment still bills what ran.
            usage.inputTokens = (usage.inputTokens ?? 0) + (step.usage?.inputTokens ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (step.usage?.outputTokens ?? 0);
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (step.usage?.inputTokenDetails?.cacheReadTokens ?? 0);
            usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0);
            usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (step.usage?.outputTokenDetails?.reasoningTokens ?? 0);
            usage.modelSteps = totalSteps;
            await workerTrace.emit({
              type: "model.step.finish",
              step: totalSteps,
              text: (step.text ?? "").slice(0, 300),
              usage: step.usage
                ? {
                    inputTokens: step.usage.inputTokens,
                    outputTokens: step.usage.outputTokens,
                    cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
                    reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens,
                  }
                : undefined,
              toolCalls: (step.toolCalls ?? []).map((call) => ({
                toolCallId: (call as { toolCallId?: string }).toolCallId ?? "",
                name: (call as { toolName?: string }).toolName ?? "unknown",
                input: ((call as { input?: unknown }).input ?? (call as { args?: unknown }).args ?? null) as unknown,
              })),
              // The results too: without them a trace shows what a worker tried and never what came back.
              toolResults: results.map((result) => {
                const raw = (result as { output?: unknown }).output ?? (result as { result?: unknown }).result ?? null;
                const output = raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
                return {
                  toolCallId: (result as { toolCallId?: string }).toolCallId ?? "",
                  name: (result as { toolName?: string }).toolName ?? "unknown",
                  outputPreview: tracePreview(output ?? ""),
                };
              }),
            });
          },
        }).catch((error: unknown) => {
          // Credit is short for this limit: ask for what can be paid, once per
          // level, instead of failing a job that needs far less than the limit.
          const afford = affordableTokens(error);
          if (afford === null && isOutOfCreditError(error)) throw new OutOfCreditError(error);
          if (afford !== null) {
            const lower = Math.floor(afford * 0.9);
            if (lower < MIN_OUTPUT_TOKENS || lower >= outputCap) throw new OutOfCreditError(error);
            outputCap = lower;
            if (inFlight.length > 0) transcript.push(...inFlight);
            inFlight = [];
            return null;
          }
          // The provider says this model takes no pictures: remember it, keep
          // what was done, take the pictures out, and go on in words. Before
          // this, the job failed here and the agent paid for it all again.
          if (!vision.canSee || !isNoImageInputError(error)) throw error;
          vision.canSee = false;
          learnCapability(runOn.provider, runOn.modelId, { vision: false });
          if (inFlight.length > 0) transcript.push(...inFlight);
          inFlight = [];
          transcript = withoutImages(transcript);
          say(prompt("worker-rules", "no-vision"));
          return null;
        });
        if (!result) continue;
        clearCreditOutage(input.accountId);
        inFlight = [];
        transcript.push(...(result.responseMessages as ModelMessage[]));
        await saveTranscript();
        // What it has cost so far, saved now: the usage page and the daily limit see a job while it runs.
        await db
          .update(delegations)
          .set({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            modelSteps: totalSteps,
          })
          .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
          .catch(noted("Saving a running worker's usage"));
        if (!closing) spendStop = await spendingStop();
        if (closing) {
          finalText = result.text;
          break;
        }
        if (cutOff && thoughtOnly) {
          // The whole answer went on hidden thinking and nothing was done. A larger
          // limit only makes it think longer: one showreel job spent 20 to 39 minutes
          // per step this way and produced nothing. Same limit, told to act in parts.
          cutOff = false;
          thoughtOnly = false;
          say(prompt("worker-rules", "thinking-cut", { tokens: outputCap }));
          continue;
        }
        if (cutOff) {
          // The answer hit the output limit mid-way, usually a whole file in one call.
          // The broken call did nothing; say so, raise the limit if the model allows, and go on.
          cutOff = false;
          cutOffs += 1;
          const ceiling = capabilities.maxOutputTokens ?? WORKER_OUTPUT_TOKENS * 2;
          const was = outputCap;
          if (cutOffs >= 2) outputCap = Math.min(ceiling, outputCap * 2);
          say(prompt("worker-rules", "output-cut", { tokens: was }));
          continue;
        }
        const notes = workerInboxes.get(input.delegationId)?.splice(0) ?? [];
        const lastStep = result.steps.at(-1);
        const endedOnText = segmentCount === 0 || (lastStep?.toolCalls?.length ?? 0) === 0;
        if (endedOnText && notes.length === 0) {
          // The model stopped by itself. Accept that only when it is a real ending.
          const text = collectWorkerText({ text: result.text, steps: stepLog }) || result.text;
          const isReport = REPORT_MARKERS.test(text);
          if (narrationNudges < 2 && !isReport && text.trim().length < 700 && (!text.trim() || NEXT_STEP_NARRATION.test(text))) {
            narrationNudges += 1;
            say(prompt("worker-rules", "keep-going"));
            continue;
          }
          if (!challengedPaths) {
            const missing = await missingClaimed(text);
            if (missing.length > 0) {
              challengedPaths = true;
              say(prompt("worker-rules", "missing-paths", { paths: missing.join(", ") }));
              continue;
            }
          }
          finalText = result.text;
          break;
        }
        // Between segments: pass on what the agent said, and keep the worker honest about progress.
        for (const note of notes) say(prompt("worker-rules", "agent-note", { note }));
        if (loopFlag) {
          loopFlag = false;
          loopStrikes += 1;
          duplicateCallCount = 0;
          lastToolCallSignature = "";
          if (stuckReason) {
            // Once: try one different way or ask. A second time ends the run with a report (loopStrikes >= 2).
            say(prompt("worker-rules", loopStrikes >= 2 ? "stuck-stop" : "stuck", { why: stuckReason }));
            stuckReason = null;
            stuckWatch.reset();
          } else {
            say(prompt("worker-rules", "repeat-loop"));
          }
        }
        if (lookOnlyStreak >= LOOK_ONLY_NUDGE_AFTER) {
          // Told twice and still only looking: it reports what it found instead
          // of reading until the ceiling. The job can be continued from the report.
          if (lookNudges >= LOOK_ONLY_NUDGES_BEFORE_STOP) {
            say(prompt("worker-rules", "look-stop", { steps: lookOnlyStreak }));
            loopStrikes = 2;
          } else {
            lookNudges += 1;
            say(prompt("worker-rules", "start-doing", { steps: lookOnlyStreak }));
          }
          lookOnlyStreak = 0;
        }
        if (
          singleCallStreak >= SINGLE_CALL_NUDGE_AFTER &&
          singleCallNudges < SINGLE_CALL_NUDGES_MAX &&
          totalSteps - lastSingleCallNudgeAt >= SINGLE_CALL_NUDGE_GAP
        ) {
          singleCallNudges += 1;
          lastSingleCallNudgeAt = totalSteps;
          say(prompt("worker-rules", "combine-steps", { steps: singleCallStreak, tokens: Math.max(1, Math.round(lastInputTokens / 1000)) }));
          singleCallStreak = 0;
        }
        if (!warnedWrapUp && WORKER_STEP_CEILING - totalSteps <= WRAP_UP_WARNING_STEPS) {
          warnedWrapUp = true;
          say(prompt("worker-rules", "wrap-up", { steps: WORKER_STEP_CEILING - totalSteps }));
        }
        // Old views of a page are stale and large, but rewriting old messages makes the
        // provider resend everything after them uncached. Drop them only once they weigh something.
        if (estimateTokens(transcript) > STALE_VIEWS_AT) transcript = dropStaleViews(transcript);
        // Nothing else old is rewritten between summaries, so every step reads the conversation
        // so far from the provider's cache. At the threshold the older part becomes one summary.
        if (estimateTokens(transcript) > compactAt) {
          if (!(await summarizeState())) trimOldSteps();
        }
      }
    } catch (error) {
      // Stopped or crashed mid-segment: keep what was done so the job can be continued.
      if (inFlight.length > 0) transcript.push(...inFlight);
      await saveTranscript();
      // And what it cost: a stopped job once showed no usage at all while the
      // provider had billed every step of it.
      await db
        .update(delegations)
        .set({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
          modelSteps: totalSteps,
        })
        .where(eq(delegations.id, input.delegationId))
        .catch(noted("Saving a stopped worker's usage"));
      throw error;
    }
    // A last step can write its tool call as text (the closing step has no tools);
    // that markup is no report. Why: one stopped run handed its agent nothing but
    // "<｜DSML｜ calls> <｜DSML｜ invoke name="bash">…" as its result.
    finalText = stripLeakedToolCall(finalText);
    await workerTrace.emit({
      type: "run.finish",
      text: finalText,
      usage: {
        inputTokens: usage.inputTokens ?? undefined,
        outputTokens: usage.outputTokens ?? undefined,
        cacheReadTokens: usage.cacheReadTokens ?? undefined,
        reasoningTokens: usage.reasoningTokens ?? undefined,
      },
      steps: totalSteps,
    });
    const outcome = { text: finalText, steps: stepLog, toolResults: recentToolResults as never[] };
    const ending = resolveWorkerEnding(outcome);
    if (ending.kind === "stall") {
      // No tools and no report — weak model ended on empty/"Let me…" narration.
      await finish(
        "failed",
        "The task was not completed — the worker stopped before acting. No findings were returned.",
        usage,
      );
      return;
    }
    const cutShortNote = cutShort ? `${prompt("worker-rules", "cut-short")}\n\n` : "";
    if (ending.kind === "report" && isToolDigestFallback(outcome)) {
      // Tools ran but the model never wrote a report. One cheap text-only pass
      // first — no tools, so it costs a fraction of a full retry.
      const digest = collectWorkerFallback(outcome);
      let recovered = "";
      try {
        const retry = await generateText({
          model,
          abortSignal: controller.signal,
          instructions: [{ role: "system" as const, content: workerReportRetryInstructions() }],
          maxOutputTokens: Math.min(outputCap, 8_000),
          messages: [
            { role: "user" as const, content: prompt("worker-rules", "report-retry-user", { task: input.task, digest }) },
          ],
          tools: {},
          stopWhen: [isStepCount(1)],
        });
        recovered = (retry.text ?? "").trim();
      } catch {
        recovered = "";
      }
      await finish(
        recovered ? "done" : "failed",
        recovered
          ? `${cutShortNote}${recovered}`.slice(0, WORKER_RESULT_MAX)
          : `The worker ran ${totalSteps} steps and wrote no report. Continue it with redirect_worker and ask what state the work is in. Last tool outputs:\n${digest}`,
        usage,
      );
      return;
    }
    // The report is kept either way: a path that is not there is a warning for
    // the agent, never a reason to throw the worker's findings away.
    const missing = ending.kind === "report" ? await missingClaimed(ending.result) : [];
    const missingNote =
      missing.length > 0 ? `${prompt("worker-rules", "missing-paths-note", { paths: missing.join(", ") })}\n\n` : "";
    // report | needs_person: deliver as-is (needs_person triggers the sign-in handover).
    await finish("done", `${cutShortNote}${missingNote}${ending.result}`, usage);
  } catch (error) {
    if (isOutOfCreditError(error)) {
      // Every job of this account would fail the same way: stop starting them for a while.
      noteCreditOutage(input.accountId, "the model provider");
      await finish("failed", (error instanceof OutOfCreditError ? error : new OutOfCreditError(error)).message);
      return;
    }
    await finish("failed", error instanceof Error ? error.message : "The worker failed.");
  } finally {
    if (activeWorkerRuns.get(input.delegationId) === controller) {
      activeWorkerRuns.delete(input.delegationId);
      forgetWorkerQuestions(input.delegationId);
      workerInboxes.delete(input.delegationId);
    }
  }
}

/**
 * Keeps large datasets/logs out of manager context while preserving every byte.
 * Workers are prompted to do this themselves; this is the deterministic safety
 * net for models that still paste a long report.
 */
async function compactWorkerReport(accountId: string, delegationId: string, report: string): Promise<string> {
  const REPORT_INLINE_MAX = 4_000;
  if (report.length <= REPORT_INLINE_MAX) return report;
  const path = `/shared/worker-results/${delegationId}.md`;
  const written = await execStdin(
    accountId,
    ["sh", "-c", `mkdir -p /shared/worker-results && cat > '${path}' && chmod 644 '${path}'`],
    Buffer.from(report, "utf8"),
  ).catch(() => null);
  if (!written || written.code !== 0) return report.slice(0, REPORT_INLINE_MAX);

  const head = report.slice(0, 2_800);
  const boundary = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(". "), head.lastIndexOf("\n"));
  const summary = head.slice(0, boundary >= 1_400 ? boundary : head.length).trimEnd();
  return `${summary}\n\nFull report: ${path}`;
}

/**
 * Names a worker can call.
 * Why: tests lock the worker to the same computer tools as the chat, plus
 * the two recall tools a worker is allowed. Voice and team tools stay off.
 * Input: whether this worker has a Linux profile. Output: sorted names.
 */
export function workerToolNames(hasComputer: boolean): string[] {
  return agentWorkerToolNames(hasComputer);
}
