/**
 * Tool execute bodies for the dispatcher registry.
 * DB: per tool — messages, delegations, agents, routines, notifications.
 */
import { deleteAgent, FireAgentError } from "../../roster/delete-agent.js";
import { answerWorkerQuestion } from "../../rooms/worker-questions.js";
import { connectSocial } from "../../social/connect.js";
import { chartData } from "@kuru/shared";
import { hitLine, mergeRanked, searchFacts, searchMessages, searchSummaries, searchTerms } from "../../memory/search.js";
import { prompt } from "../../prompt/prompts.js";
import { isRequestableToolSet, toolNamesInSet, toolSetGuidance } from "./tool-sets.js";
import {
  accountBriefInputSchema,
  ownProfileInputSchema,
  agentMemoryAddInputSchema,
  agentMemoryCorrectInputSchema,
  agentMemoryReadInputSchema,
  fireAgentInputSchema,
  hireAgentInputSchema,
  deleteRoutinesInputSchema,
  correctMemoryToolInputSchema,
  delegateSchema,
  groupConversationInputSchema,
  groupCreateInputSchema,
  memberAddInputSchema,
  notifyInputSchema,
  reactionSchema,
  rememberFactToolInputSchema,
  routineIdSchema,
  sendMessageInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  teammateUpdateSchema,
  workerRedirectInputSchema,
} from "@kuru/agent-tools";
import { takeOver } from "../../desktop/desktop.js";
import { mergeWorkerBrief } from "./repair-input.js";
import { MAX_ROUNDS_WITHOUT_PERSON, postToRoom, roundsSincePerson } from "../team-chat.js";
import { publish } from "../../rooms/stream.js";
import { resolveMention } from "../../rooms/mentions.js";
import { recentWorkLogs } from "../work-log.js";
import { accountHome } from "../../linux/linux.js";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { agents, conversations, delegations, members, messages, workerTranscripts } from "../../db/schema.js";
import { agentFacts, briefFor, correct, readHistory, remember, saveBrief } from "../../memory/memory.js";
import { embedSummaryBacklog } from "../../memory/recall.js";
import { todoList, todoWrite } from "../../memory/todos.js";
import { saveNotification } from "../../notify/notify.js";
import { createGroupRoom, deleteGroupRoom, listGroupRoomsForAgent } from "../../rooms/rooms.js";
import { inlineSharedOutputBlocks } from "../../rooms/uploads.js";
import { unpackWorkerJobDescription } from "../../rooms/worker-kinds.js";
import { saveSendMessage, saveReaction } from "../../rooms/send-message.js";
import {
  addGroupMember,
  failuresSinceLastUser,
  MAX_STARTS_PER_ASK,
  startsSinceLastAsk,
  hireSubagent,
  listTeam,
  recordDelegation,
  runWorker,
  spawnWorker,
  stopWorker,
  WorkerCapacityError,
  continueWorker,
  messageRunningWorker,
  workerStatuses,
} from "../../rooms/subagents.js";
import { AgentNameError, createAgent, isUnsetAgent, updateAgentFlags } from "../../roster/roster.js";
import { createRoom } from "../../rooms/rooms.js";
import { createProfile } from "../../linux/linux.js";
import { catalogTextForAgent, readSkillForAgent, skillCatalogForAgent } from "../../skills/agent-skills.js";
import { workerLessons } from "../../memory/worker-lessons.js";
import { readAgentFile } from "../../routines/routine-worker.js";
import { clipDescription, FULL_DESCRIPTION_CHARS, searchSkills, SHORT_DESCRIPTION_CHARS } from "../../skills/catalog-budget.js";
import { bumpAccountPromptVersions } from "../../skills/install.js";
import { publishLocalSkills } from "../../skills/local.js";
import {
  createOwnRoutine,
  deleteOwnRoutine,
  deleteOwnRoutines,
  listOwnRoutines,
  updateOwnRoutine,
} from "../../routines/routines.js";
import { emitTurnBus } from "../events/bus.js";
import { MAX_DELEGATION_DEPTH } from "../constants.js";
import { normalizeSendMessageInput } from "./normalize-send-message.js";
import { validateWorkerTask } from "./worker-task.js";
import type { ToolContext } from "./context.js";
import { startFirstHello } from "../first-hello.js";
import { ZodError } from "zod";
import { noted } from "../../log/logger.js";

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

/**
 * Saves one durable fact backed by a message in the current room.
 * Why: long-lived employees need explicit, sourceable memory rather than
 * relying on an ever-growing transcript. Agent scope is bound to the caller.
 */
/**
 * Resolves the message a memory cites.
 * Why: the model rarely has a message id to hand, and a fact it could not
 * cite was a fact it never saved. With no id (or one that is not in this
 * room) the source is the person's latest message here.
 */
async function memorySourceId(ctx: ToolContext, given?: string): Promise<string> {
  if (given) {
    const source = await readHistory(ctx.db, ctx.accountId, ctx.conversationId, { messageId: given });
    if (source.length > 0) return given;
  }
  const [latest] = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.accountId, ctx.accountId), eq(messages.conversationId, ctx.conversationId), isNull(messages.agentId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (latest) return latest.id;
  // The person may only have tapped answers so far; then the newest message of any kind is the source.
  const [any] = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.accountId, ctx.accountId), eq(messages.conversationId, ctx.conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!any) throw new Error("There is no message in this room to cite as the source.");
  return any.id;
}

async function executeRememberFact(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = rememberFactToolInputSchema.parse(input);
  const saved = await remember(ctx.db, ctx.accountId, {
    ...parsed,
    messageId: await memorySourceId(ctx, parsed.messageId),
    agentId: parsed.scope === "agent" ? ctx.agentId : null,
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(noted("Embedding new summaries"));
  return { memoryId: saved.id, scope: saved.scope, body: saved.body };
}

/**
 * Replaces an exact durable fact using a correcting message in this room.
 * Why: corrections must remove stale guidance instead of leaving two
 * contradictory memories for the employee to reconcile on every future turn.
 */
async function executeCorrectMemory(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = correctMemoryToolInputSchema.parse(input);
  const saved = await correct(ctx.db, ctx.accountId, {
    ...parsed,
    messageId: await memorySourceId(ctx, parsed.messageId),
    agentId: parsed.scope === "agent" ? ctx.agentId : null,
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(noted("Embedding new summaries"));
  return { memoryId: saved.id, scope: saved.scope, body: saved.body };
}

export async function executeSendMessage(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof sendMessageInputSchema.parse>;
  const normalized = normalizeSendMessageInput(input);
  try {
    parsed = sendMessageInputSchema.parse({
      blocks: normalized.blocks,
      replyTo: normalized.replyTo ?? null,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        error:
          'Invalid send_message blocks. Use blocks: [{ "kind": "text", "markdown": "your message" }]. Each block must include kind (text | image | code | file | widget).',
      };
    }
    throw error;
  }
  // A chart with nothing to draw would reach the person as an empty card.
  const emptyChart = parsed.blocks.some((block) => block.kind === "widget" && block.widget === "chart" && !chartData(block.props));
  if (emptyChart) {
    return {
      error:
        'The chart has no numbers to draw. Use props: { "type": "bar" | "line" | "pie", "title": "...", "labels": ["Mon", "Tue"], "values": [12, 18] }. For several lines or bar groups use "series": [{ "name": "2025", "values": [...] }] in place of "values".',
    };
  }
  const asksSecret = parsed.blocks.some((block) => block.kind === "widget" && block.widget === "secret");
  const asksDesktopHandover = parsed.blocks.some(
    (block) => block.kind === "widget" && block.widget === "desktop-handover",
  );
  if (asksDesktopHandover && ctx.linuxProfile) {
    takeOver(ctx.accountId, ctx.linuxProfile);
  }
  let deliverableBlocks = parsed.blocks;
  try {
    deliverableBlocks = await inlineSharedOutputBlocks(
      ctx.accountId,
      parsed.blocks,
      ctx.linuxProfile ? accountHome(ctx.accountId, ctx.linuxProfile) : undefined,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not attach the shared file." };
  }
  const saved = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    viaAgentId: ctx.viaAgentId ?? null,
    blocks: deliverableBlocks,
    replyTo: parsed.replyTo,
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(saved);
  await ctx.emit({ type: "message", message: saved });
  if (asksSecret || asksDesktopHandover) ctx.endTurn = true;
  return { messageId: saved.id, ...(asksSecret || asksDesktopHandover ? { endedTurn: true } : {}) };
}

export async function executeReact(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = reactionSchema.parse(input);
  const { reaction } = await saveReaction(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    messageId: parsed.messageId,
    emoji: parsed.emoji,
  });
  await ctx.emit({ type: "reaction", reaction });
  return { ok: true };
}

export async function executeNotify(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = notifyInputSchema.parse({
    title: input.title,
    body: input.body,
    urgency: input.urgency ?? "info",
  });
  const note = await saveNotification(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    title: parsed.title,
    body: parsed.body,
    urgency: parsed.urgency,
  });
  await ctx.emit({ type: "notify", notification: note });
  return { notificationId: note.id };
}

export async function executeReadHistory(ctx: ToolContext, input: Record<string, unknown>) {
  const rows =
    typeof input.messageId === "string"
      ? await readHistory(ctx.store, ctx.accountId, ctx.conversationId, { messageId: input.messageId })
      : await readHistory(ctx.store, ctx.accountId, ctx.conversationId, { search: String(input.search ?? "") });
  return rows.map((r) => ({ id: r.id, body: r.body }));
}

function skillCtx(ctx: Pick<ToolContext, "skillsRoot" | "accountId" | "linuxProfile">) {
  return { skillsRoot: ctx.skillsRoot, accountId: ctx.accountId, linuxProfile: ctx.linuxProfile };
}

export async function executeReadSkill(ctx: ToolContext, input: Record<string, unknown>) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  try {
    const name = String(input.name);
    const body = await readSkillForAgent(skillCtx(ctx), name);
    // The chat agent hands skills on; it does not follow them step by step.
    // Whole skill bodies here cost tens of thousands of tokens per turn and
    // the knowledge never reached the worker that needed it.
    // The note comes first: read last, the opening steps looked like orders
    // and the chat agent started carrying them out itself.
    return `${prompt("dispatcher", "skill-summary", { name })}\n\n${body.slice(0, SKILL_SUMMARY_CHARS)}`;
  } catch {
    return "Skill not found.";
  }
}

/** How much of a skill the chat agent sees; workers get the whole thing. */
const SKILL_SUMMARY_CHARS = 1_200;

/** How many skills a `list_skills` search returns. */
const SKILL_SEARCH_LIMIT = 8;

/**
 * Lists skills, or the few that match a search.
 * Why: the whole list with full descriptions was about 6k tokens for 55
 * skills, and it stays in the transcript. Without a query each skill gets a
 * short line; with one, the best matches get their full description.
 */
export async function executeListSkills(
  ctx: Pick<ToolContext, "skillsRoot" | "accountId" | "linuxProfile">,
  input: Record<string, unknown> = {},
) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  const skills = await skillCatalogForAgent(skillCtx(ctx));
  if (skills.length === 0) return "No skills available yet.";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return skills.map((skill) => `${skill.name}: ${clipDescription(skill.description ?? "", SHORT_DESCRIPTION_CHARS)}`).join("\n");
  }
  const matches = searchSkills(skills, query).slice(0, SKILL_SEARCH_LIMIT);
  if (matches.length === 0) return `No skill matches "${query}". Call list_skills without a query to see them all.`;
  return matches.map((skill) => `${skill.name}: ${clipDescription(skill.description ?? "", FULL_DESCRIPTION_CHARS)}`).join("\n");
}

export async function executeRefreshSkills(
  ctx: Pick<ToolContext, "db" | "skillsRoot" | "accountId" | "linuxProfile">,
) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  // A skill just installed in this agent's home becomes available to every agent on the account.
  await publishLocalSkills(ctx.accountId, true);
  const bumped = await bumpAccountPromptVersions(ctx.db, ctx.accountId);
  return { refreshed: true, agents: bumped, catalog: await catalogTextForAgent(skillCtx(ctx)) };
}

export async function executeUpdateTeammate(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof teammateUpdateSchema.parse>;
  try {
    parsed = teammateUpdateSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid update_teammate input. Required: agentId, plus label, role, personality, or jobDescription." };
    }
    throw error;
  }
  if (!parsed.label && !parsed.role && parsed.personality === undefined && !parsed.jobDescription) {
    return { error: "Pass label, role, personality, or jobDescription." };
  }
  const [target] = await ctx.store
    .select()
    .from(agents)
    .where(and(eq(agents.id, parsed.agentId), eq(agents.accountId, ctx.accountId)));
  if (!target || target.hidden) return { error: "That teammate is not on your team." };
  const mine = target.parentId === ctx.agentId || target.teamId === ctx.agentId;
  if (!mine || target.id === ctx.agentId) return { error: "You can only update a teammate you hired." };
  const patch: { name?: string; label?: string; role?: string; personality?: string; jobDescription?: string } = {};
  if (parsed.label) {
    const name = parsed.label.trim();
    const siblings = await ctx.store
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.accountId, ctx.accountId));
    if (siblings.some((row) => row.id !== target.id && row.name.toLowerCase() === name.toLowerCase())) {
      return { error: "Another agent already uses that name. Pick a different first name." };
    }
    patch.name = name;
    patch.label = name;
  }
  if (parsed.role) patch.role = parsed.role;
  if (parsed.personality !== undefined) patch.personality = parsed.personality;
  if (parsed.jobDescription) patch.jobDescription = parsed.jobDescription;
  const saved = await updateAgentFlags(ctx.store, ctx.accountId, target.id, patch);
  if (!saved) return { error: "That teammate is not on your team." };
  return { agentId: saved.id, name: saved.name, label: saved.label, role: saved.role };
}

export async function executeHireSubagent(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof subagentCreateSchema.parse>;
  try {
    // A teammate always runs on the hiring agent's model. Models guessed a
    // provider here ("openai") the account had no key for, and every job sent
    // to that teammate then failed without anyone noticing.
    const { provider: _provider, modelId: _modelId, ...rest } = input;
    parsed = subagentCreateSchema.parse(rest);
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid hire_subagent input. Required: label, role, jobDescription." };
    }
    throw error;
  }

  const hireConversationId = parsed.conversationId ?? ctx.conversationId;
  const [currentRoom] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (currentRoom?.kind === "direct" && !parsed.conversationId) {
    return {
      error:
        "Private chats stay 1:1. Call create_group with a title, then hire_subagent with conversationId set to the conversationId create_group returned.",
    };
  }
  if (parsed.conversationId) {
    const [target] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, parsed.conversationId), eq(conversations.accountId, ctx.accountId)));
    if (!target || target.kind !== "group") {
      return { error: "conversationId must be a group room id from create_group on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(
          eq(members.conversationId, parsed.conversationId),
          eq(members.accountId, ctx.accountId),
          eq(members.agentId, ctx.agentId),
        ),
      );
    if (!membership) {
      return { error: "You must be a member of that group to hire there." };
    }
  }

  let child: Awaited<ReturnType<typeof hireSubagent>>;
  try {
    child = await hireSubagent(ctx.store, {
      accountId: ctx.accountId,
      conversationId: hireConversationId,
      parentAgentId: ctx.agentId,
      label: parsed.label,
      role: parsed.role,
      personality: parsed.personality,
      jobDescription: parsed.jobDescription,
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "hire_subagent failed.";
    return { error: message };
  }
  const card = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    blocks: [{ kind: "widget", widget: "agent-card", props: { agentId: child.id, label: child.label, name: child.name } }],
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(card);
  await ctx.emit({ type: "message", message: card });
  return { agentId: child.id, name: child.name, hiredInConversationId: hireConversationId };
}

/**
 * Starts a visible teammate turn without blocking the parent.
 * Why: a model call cannot reliably finish inside the old 2s race. That race
 * marked healthy teammate turns failed while their messages kept arriving.
 * Persistent teammates speak in the group; hidden workers remain parent-only.
 */
export async function executeDelegate(
  ctx: ToolContext,
  input: Record<string, unknown>,
  runDelegatedTurn: (args: {
    accountId: string;
    conversationId: string;
    runId: string;
    parentAgentId: string;
    childAgentId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: ToolContext["emittedMessages"];
    emit: ToolContext["emit"];
    delegationDepth: number;
    generate?: ToolContext["generate"];
  }) => Promise<Array<{ body: string }>>,
): Promise<unknown> {
  const parsed = delegateSchema.parse({
    agentId: input.agentId,
    task: input.task,
    conversationId: input.conversationId,
  }) as { agentId: string; task: string; conversationId?: string };
  if ((ctx.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH) {
    throw new Error("Delegation is already two levels deep — do this part yourself.");
  }
  const target = await resolveGroupTarget(ctx, parsed.conversationId, "delegate", parsed.agentId);
  if ("error" in target) return target;
  const [inGroup] = await ctx.store
    .select({ agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.conversationId, target.conversationId),
        eq(members.accountId, ctx.accountId),
        eq(members.agentId, parsed.agentId),
      ),
    );
  if (!inGroup) {
    return {
      error: `That teammate is not in group id:${target.conversationId}. hire_subagent with that conversationId adds them — do not call add_to_group after hire. add_to_group is only for an existing teammate missing from the group.`,
    };
  }
  // Real model: the request is a visible message in the group and the
  // teammate answers there. (The stub path below is kept for unit tests.)
  if (!ctx.generate) return askTeammateInGroup(ctx, target.conversationId, parsed.agentId, parsed.task);
  const row = await recordDelegation(ctx.store, {
    accountId: ctx.accountId,
    conversationId: target.conversationId,
    parentAgentId: ctx.agentId,
    agentId: parsed.agentId,
    task: parsed.task,
  });
  void runDelegatedTurn({
    accountId: ctx.accountId,
    conversationId: target.conversationId,
    runId: ctx.runId,
    parentAgentId: ctx.agentId,
    childAgentId: parsed.agentId,
    delegationId: row.id,
    task: parsed.task,
    skillsRoot: ctx.skillsRoot,
    nextTime: ctx.nextTime,
    emittedMessages: ctx.emittedMessages,
    emit: ctx.emit,
    delegationDepth: (ctx.delegationDepth ?? 0) + 1,
    generate: ctx.generate,
  })
    .then(async (bubbles) => {
      await ctx.db
        .update(delegations)
        .set({ status: "done", result: bubbles.map((bubble) => bubble.body).join("\n\n").slice(0, 20_000) })
        .where(eq(delegations.id, row.id));
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Delegation failed.";
      await ctx.db
        .update(delegations)
        .set({ status: "failed", result: message.slice(0, 20_000) })
        .where(eq(delegations.id, row.id))
        .catch(noted("Marking a delegation as failed"));
    });
  return { delegationId: row.id, status: "started", conversationId: target.conversationId };
}

/**
 * Passes a message to another agent on the account.
 * Why: the person says "tell Max that..." to Zoe. Max and Zoe share no room,
 * so the message lands in Max's private chat as a "Message from Zoe" badge
 * (where the person will see it), and Max is woken once to take it in.
 * An agent woken by such a message cannot send one back in the same turn,
 * so two agents never end up talking in circles.
 */
async function executeMessageAgent(ctx: ToolContext, input: Record<string, unknown>): Promise<unknown> {
  const wanted = String(input.agent ?? "").trim();
  const text = String(input.message ?? "").trim();
  if (!wanted || !text) return { error: "Give the agent's name and the message to pass on." };
  const wantsReply = input.wantsReply !== false && String(input.wantsReply) !== "false";
  if (ctx.hiddenTurn) {
    return { error: "This turn was started by a note, not by the person. Answer in your own chat instead of messaging another agent." };
  }
  if ((ctx.agentMessages ?? 0) >= 3) return { error: "Three messages to other agents this turn is the limit." };
  const roster = await ctx.store
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(and(eq(agents.accountId, ctx.accountId), eq(agents.hidden, false)));
  const others = roster.filter((row) => row.id !== ctx.agentId);
  const targetId = others.find((row) => row.id === wanted)?.id ?? resolveMention(wanted.replace(/^@/, ""), others);
  const target = others.find((row) => row.id === targetId);
  if (!target) {
    return { error: `No agent called "${wanted}" on this account. Agents here: ${others.map((row) => row.label || row.name).slice(0, 15).join(", ") || "none"}.` };
  }
  const [room] = await ctx.store
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.accountId, ctx.accountId), eq(conversations.kind, "direct"), eq(conversations.ownerAgentId, target.id)))
    .orderBy(conversations.createdAt)
    .limit(1);
  const label = target.label?.trim() || target.name;
  if (!room) return { error: `${label} has no private chat yet, so the message has nowhere to land.` };
  const me = roster.find((row) => row.id === ctx.agentId);
  const myLabel = me?.label?.trim() || me?.name || "Another agent";
  await postToRoom(ctx.db, {
    accountId: ctx.accountId,
    conversationId: room.id,
    agentId: ctx.agentId,
    body: text,
    runId: ctx.runId,
    // An open request: the answer is sent back to this room when it is ready.
    relay: {
      kind: "from",
      sourceConversationId: ctx.conversationId,
      peers: wantsReply ? ([{ id: ctx.agentId, label: myLabel, awaiting: true }] as never) : [],
    },
  });
  const [here] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (here?.kind === "direct") {
    await postToRoom(ctx.db, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      body: text,
      runId: ctx.runId,
      relay: { kind: "to", sourceConversationId: room.id, peers: [{ id: target.id, label }] },
      createdAt: ctx.nextTime(),
    });
  }
  ctx.agentMessages = (ctx.agentMessages ?? 0) + 1;
  const { accountId, skillsRoot, db } = ctx;
  void (async () => {
    const { runTurn } = await import("../orchestrator.js");
    const cue = prompt("cues", wantsReply ? "agent-request" : "agent-message", { from: myLabel, message: text.slice(0, 4_000) });
    await runTurn(db, accountId, room.id, cue, undefined, skillsRoot, {
      cue,
      speakerId: target.id,
      acquireTimeoutMs: 300_000,
      onEvent: (event) => publish(accountId, room.id, event),
    }).catch(noted("A delegated teammate's turn"));
  })();
  if (wantsReply) {
    // Waiting on another agent is a handoff: the turn ends and the answer wakes this agent.
    ctx.handedOff = true;
    return {
      delivered: true,
      to: label,
      note: `${label} is working on it. Their answer comes back to this chat on its own, and you pass it on then. Nothing more to do this turn.`,
    };
  }
  return { delivered: true, to: label, note: `${label} has it and it shows in their chat with the person.` };
}

/**
 * Drops the "You are X on the team" opener models put on a request.
 * Why: the teammate already has its own name, role and job. A colleague
 * would just say what they need.
 */
export function plainAsk(task: string): string {
  return task
    .replace(/^\s*you are [^.\n]{1,120}[.\n]\s*/i, "")
    .replace(/^\s*\*\*your (job|task)[^\n]*\*\*:?\s*/i, "")
    .trim();
}

/**
 * Asks a teammate for something where the person can see it.
 * In the group itself: posts "@name request" as this agent's message; the
 * room's own mention routing gives the teammate the floor next.
 * From another room (the private chat): posts the same message in the group,
 * leaves a "Messaged X" badge in the private chat, and starts the teammate's
 * turn in the group. The lead hears back through `reportRoundToLead`.
 */
async function askTeammateInGroup(
  ctx: ToolContext,
  groupId: string,
  teammateId: string,
  task: string,
): Promise<unknown> {
  const [teammate] = await ctx.store
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(and(eq(agents.id, teammateId), eq(agents.accountId, ctx.accountId)));
  if (!teammate) return { error: "That teammate is not on this account. list_team shows who is." };
  const label = teammate.label?.trim() || teammate.name;
  const ask = plainAsk(task) || task.trim();
  const body = `@${teammate.name} ${ask}`;
  const rounds = await roundsSincePerson(ctx.db, ctx.accountId, ctx.agentId);
  if (rounds >= MAX_ROUNDS_WITHOUT_PERSON) {
    return {
      error: `The team has already done ${rounds} rounds since the person last wrote. Tell them where things stand and what you need from them, then wait for their answer.`,
    };
  }
  const row = await recordDelegation(ctx.store, {
    accountId: ctx.accountId,
    conversationId: groupId,
    parentAgentId: ctx.agentId,
    agentId: teammateId,
    task: ask,
  });
  if (groupId === ctx.conversationId) {
    const saved = await saveSendMessage(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      viaAgentId: null,
      blocks: [{ kind: "text", markdown: body }],
      createdAt: ctx.nextTime(),
    });
    ctx.emittedMessages.push(saved);
    await ctx.emit({ type: "message", message: saved });
    await ctx.db
      .update(delegations)
      .set({ status: "done", result: "Asked in the group; the reply is in the group chat." })
      .where(eq(delegations.id, row.id));
    return {
      status: "asked",
      note: `Your message to ${label} is posted in this chat and they answer here next. Nothing more to do this turn.`,
    };
  }
  const startedAt = new Date();
  await postToRoom(ctx.db, { accountId: ctx.accountId, conversationId: groupId, agentId: ctx.agentId, body, runId: ctx.runId });
  const [origin] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (origin?.kind === "direct") {
    await postToRoom(ctx.db, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      body: ask,
      runId: ctx.runId,
      relay: { kind: "to", sourceConversationId: groupId, peers: [{ id: teammate.id, label }] },
      createdAt: ctx.nextTime(),
    });
  }
  const { accountId, agentId: leadId, conversationId: originId, skillsRoot, db } = ctx;
  void (async () => {
    const { runTurn } = await import("../orchestrator.js");
    const start = (conversationId: string, cue: string, speakerId: string) =>
      runTurn(db, accountId, conversationId, cue, undefined, skillsRoot, {
        cue,
        speakerId,
        acquireTimeoutMs: 600_000,
        onEvent: (event) => publish(accountId, conversationId, event),
      });
    try {
      const [lead] = await db.select({ name: agents.name, label: agents.label }).from(agents).where(eq(agents.id, leadId));
      await start(groupId, prompt("cues", "team-ask", { lead: lead?.label?.trim() || lead?.name || "The lead" }), teammateId);
      const replies = await db
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.conversationId, groupId), eq(messages.agentId, teammateId), gt(messages.createdAt, startedAt)))
        .orderBy(messages.createdAt);
      await db
        .update(delegations)
        .set({
          status: "done",
          result: (replies.map((reply) => reply.body).join("\n\n") || "No reply was posted.").slice(0, 20_000),
        })
        .where(eq(delegations.id, row.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The teammate's turn failed.";
      await db
        .update(delegations)
        .set({ status: "failed", result: reason.slice(0, 20_000) })
        .where(eq(delegations.id, row.id))
        .catch(noted("Marking a delegation as failed"));
      // A teammate that cannot run must not look like one that is "on it".
      await start(originId, prompt("cues", "team-failed", { teammate: label, reason: reason.slice(0, 400) }), leadId).catch(noted("Starting the turn that reports a failed teammate"));
    }
  })();
  return {
    status: "asked",
    conversationId: groupId,
    note: `Your message to ${label} is posted in the team chat. Their answer comes back to you on its own.`,
  };
}

/**
 * Picks the group a team tool should touch.
 * Why: a private-chat turn has no crew in the room. Explicit conversationId
 * wins; otherwise infer the sticky group (single owned group, or the one
 * containing the child) so the model is not forced to copy UUIDs. Generic:
 * works for any team purpose, not one example crew. No new tool, no new step.
 */
async function resolveGroupTarget(
  ctx: ToolContext,
  conversationId: string | undefined,
  tool: "delegate" | "add_to_group",
  childAgentId?: string,
): Promise<{ conversationId: string } | { error: string }> {
  if (conversationId) {
    const [room] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, ctx.accountId)));
    if (!room || room.kind !== "group") {
      return { error: "conversationId must be a group id from Groups: in your prompt on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(eq(members.conversationId, conversationId), eq(members.accountId, ctx.accountId), eq(members.agentId, ctx.agentId)),
      );
    if (!membership) return { error: "You must be a member of that group." };
    return { conversationId };
  }
  const [current] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (current?.kind !== "direct") {
    const targetId = ctx.conversationId;
    const [room] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, targetId), eq(conversations.accountId, ctx.accountId)));
    if (!room || room.kind !== "group") {
      return { error: "conversationId must be a group id from Groups: in your prompt on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(eq(members.conversationId, targetId), eq(members.accountId, ctx.accountId), eq(members.agentId, ctx.agentId)),
      );
    if (!membership) return { error: "You must be a member of that group." };
    return { conversationId: targetId };
  }
  const { listGroupRoomsForAgent } = await import("../../rooms/rooms.js");
  const groups = await listGroupRoomsForAgent(ctx.store, ctx.accountId, ctx.agentId).catch(() => []);
  if (groups.length === 0) {
    return {
      error:
        tool === "delegate"
          ? "No group yet. Call create_group once with a title, then hire_subagent there, then delegate. Copy the group id from Groups: in your prompt."
          : "No group yet. Call create_group once, then hire_subagent there. Copy the group id from Groups: in your prompt.",
    };
  }
  if (groups.length === 1 && groups[0]) {
    return { conversationId: groups[0].conversationId };
  }
  if (childAgentId) {
    const containing: { conversationId: string; title: string; owned: boolean }[] = [];
    for (const group of groups) {
      const [hit] = await ctx.store
        .select({ agentId: members.agentId })
        .from(members)
        .where(
          and(
            eq(members.conversationId, group.conversationId),
            eq(members.accountId, ctx.accountId),
            eq(members.agentId, childAgentId),
          ),
        );
      if (hit) containing.push(group);
    }
    if (containing.length === 1 && containing[0]) {
      return { conversationId: containing[0].conversationId };
    }
    if (containing.length > 1) {
      const list = containing.map((group) => `"${group.title}" (id:${group.conversationId})`).join("; ");
      return { error: `That teammate is in several groups. Pass conversationId copied from Groups: — candidates: ${list}.` };
    }
  }
  const list = groups
    .slice(0, 5)
    .map((group) => `"${group.title}" (id:${group.conversationId})`)
    .join("; ");
  return {
    error: `You are in a private chat with several groups. Pass conversationId copied verbatim from Groups: in your prompt — candidates: ${list}. Do not create another group when one title already matches.`,
  };
}

export async function executeAddToGroup(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: { agentId: string; conversationId?: string };
  try {
    parsed = memberAddInputSchema.parse(input) as { agentId: string; conversationId?: string };
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid add_to_group input. Required: agentId (UUID). From a private chat also pass conversationId." };
    }
    throw error;
  }
  const target = await resolveGroupTarget(ctx, parsed.conversationId, "add_to_group", parsed.agentId);
  if ("error" in target) return target;
  try {
    const row = await addGroupMember(ctx.store, {
      accountId: ctx.accountId,
      conversationId: target.conversationId,
      agentId: parsed.agentId,
    });
    return { agentId: row.agentId, conversationId: target.conversationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "add_to_group failed.";
    return { error: message };
  }
}

/**
 * Max workers started per turn. Only successful starts count: a rejected
 * brief must not use up the turn's chance to start any work at all.
 */
export const MAX_SPAWNS_PER_TURN = 3;

// A function, not a constant: this file and rooms/subagents.ts import each other, and the limit is not set yet while this file loads.
const roundsSpent = (): string =>
  `This work has been started ${MAX_STARTS_PER_ASK} times since the person last wrote, and it is not started again without them. Tell them plainly where it stands and what went wrong, in one message, then stop.`;

export async function executeSpawnWorker(ctx: ToolContext, input: Record<string, unknown>) {
  if ((ctx.spawnCount ?? 0) >= MAX_SPAWNS_PER_TURN) {
    return {
      error: "Already spawned several workers this turn. send_message what you started, then stop — results arrive on their own.",
    };
  }
  // A turn nobody typed for (a worker's result came back) cannot keep restarting the same request for ever.
  if (ctx.hiddenTurn && (await startsSinceLastAsk(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId).catch(() => 0)) >= MAX_STARTS_PER_ASK) {
    return { error: roundsSpent() };
  }
  // The brief sometimes arrives split: a title in `task`, the detail in `instructions`.
  input = mergeWorkerBrief(input);
  const task = String(input.task ?? "");
  const failed = await failuresSinceLastUser(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId, task);
  if (failed >= 2) {
    return {
      error:
        "Two workers already failed on this same task since the person's last message. A different task can still start. send_message what failed, in plain words, then stop.",
    };
  }
  const valid = validateWorkerTask(task);
  if (!valid.ok) return { error: valid.hint };
  // A worker told "You are <teammate>" is the lead doing a teammate's job out
  // of sight. The teammate exists; ask them where the team can see it.
  const persona = /^\s*you are ([A-Za-z][\w-]{1,40})/i.exec(task)?.[1]?.toLowerCase();
  if (persona) {
    const team = await listTeam(ctx.store, ctx.accountId, ctx.agentId).catch(() => []);
    const mate = team.find((member) => (member.label ?? "").toLowerCase() === persona || member.name.toLowerCase().startsWith(persona));
    if (mate) {
      return {
        error: `${mate.label || mate.name} is a real teammate (id:${mate.id}). Ask them with delegate so the work happens in the team chat, instead of a worker playing their part.`,
      };
    }
  }
  // De-dupe: same parent+room already running (near-)identical task — reuse it
  // instead of burning a second worker on the same question. Independent jobs
  // (different task heads) still run side by side.
  const taskHead = valid.task.trim().slice(0, 80).toLowerCase();
  if (taskHead.length >= 5) {
    const rows = await ctx.store
      .select({ childAgentId: delegations.childAgentId, task: delegations.task })
      .from(delegations)
      .where(
        and(
          eq(delegations.accountId, ctx.accountId),
          eq(delegations.conversationId, ctx.conversationId),
          eq(delegations.parentAgentId, ctx.agentId),
          eq(delegations.status, "running"),
        ),
      )
      .orderBy(desc(delegations.createdAt))
      .limit(5);
    const same = rows.find((row) => {
      const rowHead = row.task.trim().slice(0, 80).toLowerCase();
      return rowHead === taskHead || (taskHead.length >= 10 && (rowHead.includes(taskHead) || taskHead.includes(rowHead)));
    });
    if (same) {
      return {
        error: `That job is already running as ${same.childAgentId} and its result will be delivered on its own. End the turn — do not spawn a duplicate.`,
        workerId: same.childAgentId,
      };
    }
  }
  const parsed = spawnWorkerToolInputSchema.parse({ ...input, task: valid.task });
  // A brief kept in a file goes to the worker with the task, read now, so the worker spends no step opening it.
  if (parsed.briefFile) {
    const text = await readAgentFile(ctx.accountId, ctx.linuxProfile ?? null, parsed.briefFile).catch(() => null);
    if (text === null) return { error: `Could not read ${parsed.briefFile}. Write the brief there with write first, or put it in task.` };
    parsed.task = prompt("worker-rules", "brief-file", { task: parsed.task, path: parsed.briefFile, brief: text });
  }
  // A follow-up to work that just ran goes back to the worker that did it,
  // with its conversation intact, instead of to a blank one that has to
  // rediscover the project before it can change a line.
  const earlier = (ctx.spawnCount ?? 0) === 0 ? await workerToContinue(ctx, parsed.kind) : null;
  if (earlier) {
    try {
      const continued = await continueWorker(ctx.store, {
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentAgentId: ctx.agentId,
        workerId: earlier,
        task: parsed.task,
      });
      if (continued.resumeFrom) {
        ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
        launchDetachedWorker(ctx, continued, parsed.task, undefined, {
          skills: await workerSkills(ctx, parsed.task, parsed.skills ?? []),
          context: await workerContext(ctx, parsed.task),
          resumeFrom: continued.resumeFrom,
        });
        return {
          workerId: continued.workerId,
          delegationId: continued.delegationId,
          status: continued.status,
          continued: true,
          note: "The worker that did the earlier part of this job is continuing it and still knows what it did.",
        };
      }
      // Nothing saved to continue from: the delegation just made runs as a fresh job.
      ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
      launchDetachedWorker(ctx, continued, parsed.task, undefined, {
        skills: await workerSkills(ctx, parsed.task, parsed.skills ?? []),
        context: await workerContext(ctx, parsed.task),
      });
      return { workerId: continued.workerId, delegationId: continued.delegationId, status: continued.status };
    } catch {
      // Could not continue that worker (gone, or busy again): start a fresh one below.
    }
  }
  let spawned: Awaited<ReturnType<typeof spawnWorker>>;
  try {
    spawned = await spawnWorker(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      parentAgentId: ctx.agentId,
      // The model writes only the brief; the row's label and role are derived.
      label: workerLabel(parsed.task),
      role: `${parsed.kind} worker`,
      personality: "",
      jobDescription: parsed.task.slice(0, 200),
      task: parsed.task,
      kind: parsed.kind,
      instructions: parsed.instructions,
      maxSteps: parsed.maxSteps,
    });
  } catch (error) {
    if (error instanceof WorkerCapacityError) {
      return { error: error.message, workers: error.workers };
    }
    throw error;
  }
  ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
  launchDetachedWorker(ctx, spawned, parsed.task, parsed.maxSteps, {
    skills: await workerSkills(ctx, parsed.task, parsed.skills ?? []),
    context: await workerContext(ctx, parsed.task),
  });
  return spawned;
}

/** How long unfinished work stays open for the same worker to pick up. */
const CONTINUE_UNFINISHED_MS = 6 * 60 * 60 * 1000;

/** True when a worker's report says the job is not complete. */
export function reportLooksUnfinished(status: string, result: string | null): boolean {
  if (status === "failed") return true;
  const text = result ?? "";
  return /\[This worker was stopped|\bnot finished\b|\bunfinished\b|\bnot (yet )?(rendered|completed|done)\b|\bcould not\b|\bcouldn['’]t\b|\bNEEDS_PERSON\b/i.test(text);
}

/**
 * The worker a new job in this chat should continue, if any.
 * Why: work that was cut off (a stop, a restart, a blocker) is best finished
 * by the worker that knows the files and what was tried. A job that finished
 * cleanly is not continued: the next job used to inherit its whole
 * conversation even when it was unrelated, so a new video started at 100,000
 * tokens carrying three earlier jobs, and a research task carried a video
 * build. A follow-up on finished work goes through redirect_worker instead.
 * Output: a free worker id whose last job here is unfinished, recent and of the same kind, or null.
 */
async function workerToContinue(ctx: ToolContext, kind: string): Promise<string | null> {
  const [last] = await ctx.store
    .select({
      childAgentId: delegations.childAgentId,
      status: delegations.status,
      result: delegations.result,
      heartbeatAt: delegations.heartbeatAt,
      jobDescription: agents.jobDescription,
    })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, ctx.accountId),
        eq(delegations.conversationId, ctx.conversationId),
        eq(delegations.parentAgentId, ctx.agentId),
        eq(agents.hidden, true),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!last || last.status === "running") return null;
  if (unpackWorkerJobDescription(last.jobDescription).kind !== kind) return null;
  if (!reportLooksUnfinished(last.status, last.result)) return null;
  if (Date.now() - last.heartbeatAt.getTime() > CONTINUE_UNFINISHED_MS) return null;
  const [saved] = await ctx.store
    .select({ delegationId: workerTranscripts.delegationId })
    .from(workerTranscripts)
    .where(eq(workerTranscripts.childAgentId, last.childAgentId))
    .limit(1);
  return saved ? last.childAgentId : null;
}

/** Most skills one worker carries in its prompt. */
const MAX_WORKER_SKILLS = 5;

/**
 * Picks the skills a worker starts with.
 * Why: the chat agent reads skills to plan, then forgets to pass them on, so
 * the worker builds from a summary and guesses the rest (a wrong CLI flag, a
 * composition that renders blank). Whatever the agent named, mentioned in the
 * brief, or read lately travels with the job.
 * Input: the brief and the names the model passed. Output: skill names, best first.
 */
async function workerSkills(ctx: ToolContext, task: string, named: string[]): Promise<string[]> {
  const picked = new Set(named);
  const readNow = [...(ctx.touched ?? [])].filter((item) => item.startsWith("skill ")).map((item) => item.slice(6));
  const catalog = await skillCatalogForAgent({
    skillsRoot: ctx.skillsRoot,
    accountId: ctx.accountId,
    linuxProfile: ctx.linuxProfile ?? undefined,
  }).catch(() => []);
  const known = new Set(catalog.map((skill) => skill.name));
  const lower = task.toLowerCase();
  const mentioned = catalog.filter((skill) => skill.name.length >= 4 && lower.includes(skill.name.toLowerCase()));
  // A brief that lists many skills is talking about them, not asking to follow them.
  if (mentioned.length <= 3) for (const skill of mentioned) picked.add(skill.name);
  for (const name of readNow) picked.add(name);
  const recent = await recentWorkLogs(ctx.db, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    since: new Date(Date.now() - 6 * 60 * 60 * 1000),
  }).catch(() => []);
  // Newest runs first: what was read last is closest to the job at hand.
  for (const row of [...recent].reverse()) {
    for (const entry of row.entries) {
      if (entry.tool !== "read_skill" || entry.failed) continue;
      // The log stores a read_skill call as the bare skill name.
      const name = entry.input.trim();
      if (name && !name.includes(" ")) picked.add(name);
    }
  }
  return [...picked].filter((name) => known.size === 0 || known.has(name)).slice(0, MAX_WORKER_SKILLS);
}

/** Short human label for a worker row, from the first words of its brief. */
export function workerLabel(task: string): string {
  const words = task.replace(/^\s*goal\s*:\s*/i, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return (words.replace(/[.:;,]+$/, "").slice(0, 60) || "Worker").trim();
}

/**
 * Background a blank worker would otherwise lack or redo.
 * Why: the brief is the worker's whole world. Attaching the person's own
 * words and what was already looked at keeps briefs short and stops the
 * worker repeating reads the parent just did.
 * Output: text appended to the task the worker sees (not stored as the task).
 */
async function workerContext(ctx: ToolContext, task: string): Promise<string> {
  const lines: string[] = [];
  // The person often gives a job over several messages ("make a video", then
  // "15 seconds, 480p"). The worker gets all of the recent ones, oldest first.
  const said = await ctx.db
    .select({ body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, ctx.accountId),
        eq(messages.conversationId, ctx.conversationId),
        isNull(messages.agentId),
        gt(messages.createdAt, new Date(Date.now() - 3 * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(4);
  const quoted = said
    .reverse()
    .map((row) => row.body.replace(/\s+/g, " ").trim().slice(0, 1200))
    .filter(Boolean)
    .map((body) => `- "${body}"`);
  if (quoted.length > 0) lines.push(prompt("worker-rules", "context-person", { messages: quoted.join("\n") }));
  // A worker started from a team chat needs the team's goal as much as the teammate does.
  const [here] = await ctx.db
    .select({ kind: conversations.kind, brief: conversations.brief })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (here?.kind === "group" && here.brief?.trim()) lines.push(`Team brief:\n${here.brief.trim().slice(0, 2_000)}`);
  // The worker does the real job, so it needs to know who the job is for.
  const brief = await briefFor(ctx.db, ctx.accountId).catch(() => null);
  if (brief) lines.push(`About the person (their standing brief):\n${brief.slice(0, 2_000)}`);
  // Skills are not listed here: the ones that matter are loaded into the worker.
  const touched = [...(ctx.touched ?? [])].filter((item) => !item.startsWith("skill ")).slice(0, 20);
  if (touched.length > 0) lines.push(prompt("worker-rules", "context-touched", { list: touched.join(", ") }));
  // How the person wants this kind of work done, as they taught this agent.
  const lessons = await workerLessons(ctx.db, ctx.accountId, ctx.agentId, task).catch(() => "");
  if (lessons) lines.push(lessons);
  return lines.join("\n");
}

/** Starts a spawned worker detached with settle fanout. Shared by spawn + redirect. */
function launchDetachedWorker(
  ctx: ToolContext,
  spawned: { workerId: string; delegationId: string },
  task: string,
  maxSteps?: number,
  extra?: { skills?: string[]; context?: string; resumeFrom?: string },
): void {
  void runWorker(ctx.db, {
    skills: extra?.skills,
    context: extra?.context,
    resumeFrom: extra?.resumeFrom,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    childId: spawned.workerId,
    delegationId: spawned.delegationId,
    task,
    maxSteps,
    skillsRoot: ctx.skillsRoot,
    onSettled: (settled) => {
      void emitTurnBus({
        type: "worker.settled",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentAgentId: ctx.agentId,
        delegationId: spawned.delegationId,
        skillsRoot: ctx.skillsRoot,
        workerId: settled.workerId,
        task: settled.task,
        result: settled.result,
        status: settled.status,
      });
    },
  });
}

/**
 * Talks to one of this agent's workers without losing what it knows.
 * Running: the note is handed to it and read before its next step.
 * Finished or stopped: the same worker starts again from its saved
 * conversation with the note as its new instruction.
 */
export async function executeRedirectWorker(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = workerRedirectInputSchema.parse(input);
  const [latest] = await ctx.store
    .select()
    .from(delegations)
    .where(and(eq(delegations.childAgentId, parsed.workerId), eq(delegations.accountId, ctx.accountId)))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!latest) return { error: "No work found for that worker id. Use check_worker to list your workers." };
  if (latest.parentAgentId !== ctx.agentId) return { error: "That worker does not belong to you." };
  if (latest.status === "running") {
    // A worker waiting on a question gets this as its answer, at once, instead of as a note before its next step.
    if (answerWorkerQuestion(latest.id, parsed.instruction)) {
      // In a turn started by the question itself there is nothing more to say to the person.
      if (ctx.hiddenTurn) ctx.handedOff = true;
      return { workerId: parsed.workerId, delegationId: latest.id, status: "running", delivered: true, note: "The worker has your answer and is carrying on. Its result still arrives on its own." };
    }
    if (messageRunningWorker(latest.id, parsed.instruction)) {
      return {
        workerId: parsed.workerId,
        delegationId: latest.id,
        status: "running",
        delivered: true,
        note: "The worker reads this before its next step and keeps everything it has done. Its result still arrives on its own.",
      };
    }
    // Marked running with nothing behind it (the system restarted): close it, then continue below.
    await stopWorker(ctx.store, ctx.accountId, parsed.workerId);
  }
  // A turn nobody typed for (a worker's result came back) cannot keep restarting the same request for ever.
  if (ctx.hiddenTurn && (await startsSinceLastAsk(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId).catch(() => 0)) >= MAX_STARTS_PER_ASK) {
    return { error: roundsSpent() };
  }
  ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
  if (ctx.spawnCount > MAX_SPAWNS_PER_TURN) {
    return {
      error: "Already started several workers this turn. Tell the person what you started, then stop — results arrive on their own.",
    };
  }
  let continued: Awaited<ReturnType<typeof continueWorker>>;
  try {
    continued = await continueWorker(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      parentAgentId: ctx.agentId,
      workerId: parsed.workerId,
      task: parsed.instruction,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That worker could not be continued." };
  }
  launchDetachedWorker(ctx, continued, parsed.instruction, undefined, {
    context: await workerContext(ctx, parsed.instruction),
    resumeFrom: continued.resumeFrom ?? undefined,
  });
  return {
    workerId: continued.workerId,
    delegationId: continued.delegationId,
    status: continued.status,
    continued: true,
    note: "The same worker is continuing with what it already knows. Its result arrives on its own.",
  };
}

/**
 * Looks at this agent's workers: what is running, for how long, what each did last.
 * Why: the honest answer to "is it still going?" comes from looking, not from memory.
 */
export async function executeCheckWorker(ctx: ToolContext, input: Record<string, unknown>) {
  const workerId = typeof input.workerId === "string" && input.workerId.trim() ? input.workerId.trim() : undefined;
  const workers = await workerStatuses(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    workerId,
  });
  const running = workers.filter((worker) => worker.status === "running").length;
  return {
    running,
    summary:
      running > 0
        ? `${running} worker${running === 1 ? " is" : "s are"} running right now.`
        : "Nothing is running right now. If the person is waiting on work, it has to be started or continued.",
    workers,
  };
}

/**
 * Searches facts, folded summaries and old messages across this agent's rooms.
 * Why: the prompt carries only a slice of a years-long history; this is how
 * the agent reaches the rest on demand. Full text always, so it works with no
 * embedding key.
 */
export async function executeSearchMemory(ctx: ToolContext, input: Record<string, unknown>) {
  const query = String(input.query ?? "").trim();
  const terms = searchTerms(query);
  if (terms.length === 0) return { error: "Give a few distinctive words or names to search for." };
  const day = (value: unknown, endOfDay: boolean): Date | undefined => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  const from = day(input.from, false);
  const to = day(input.to, true);
  const scope = { accountId: ctx.accountId, agentId: ctx.agentId, terms };
  const inRange = (hit: { at: Date }): boolean => (!from || hit.at >= from) && (!to || hit.at <= to);
  const [facts, summaries, old] = await Promise.all([
    searchFacts(ctx.db, { ...scope, limit: 6 }),
    searchSummaries(ctx.db, { ...scope, limit: 6 }),
    searchMessages(ctx.db, { ...scope, limit: 6, from, to }),
  ]);
  const hits = mergeRanked([facts.filter(inRange), summaries.filter(inRange), old], 10);
  if (hits.length === 0) return "Nothing found. Try other words, a name, or a wider date range.";
  return hits.map((hit) => `${hit.source} · ${hitLine(hit, 400)}`).join("\n");
}

/** Turns on one optional tool set for the rest of the turn and explains how to use it. */
/**
 * Finds another agent on this account by name, label or id.
 * Input: the tool context and what the model wrote. Output: the agent, or an error listing who exists.
 */
async function otherAgentByName(ctx: ToolContext, wanted: string) {
  const roster = await ctx.store
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(and(eq(agents.accountId, ctx.accountId), eq(agents.hidden, false)));
  const others = roster.filter((row) => row.id !== ctx.agentId);
  const id = others.find((row) => row.id === wanted)?.id ?? resolveMention(wanted.replace(/^@/, ""), others);
  const target = others.find((row) => row.id === id);
  if (target) return { ...target, label: target.label?.trim() || target.name };
  const names = others.map((row) => row.label || row.name).slice(0, 15).join(", ") || "none";
  return { error: `No agent called "${wanted}" on this account. Agents here: ${names}.` };
}

/**
 * Removes one of the person's agents for good (support agent only).
 * Why: an agent the person let go stayed in every roster and could still be
 * messaged or handed work. Auto-review asks the person before this runs, even
 * when they turned Auto-review off, because nothing here can be undone.
 */
async function executeFireAgent(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = fireAgentInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Give the name of the agent to remove." };
  const target = await otherAgentByName(ctx, parsed.data.agent);
  if ("error" in target) return target;
  // Its background jobs are stopped first, so none is left running for an agent that is gone.
  const running = await ctx.store
    .select({ childAgentId: delegations.childAgentId })
    .from(delegations)
    .where(and(eq(delegations.accountId, ctx.accountId), eq(delegations.parentAgentId, target.id), eq(delegations.status, "running")));
  for (const row of running) await stopWorker(ctx.store, ctx.accountId, row.childAgentId).catch(noted("Stopping a removed agent's worker"));
  try {
    const fired = await deleteAgent(ctx.db, ctx.accountId, target.id);
    return {
      removed: fired.label || fired.name,
      chats: fired.chats,
      messages: fired.messages,
      note: "Removed for good. Update the brief's \"Who does what\" now, and tell whoever takes over its area what they own.",
    };
  } catch (error) {
    if (error instanceof FireAgentError) return { error: error.message };
    throw error;
  }
}

/** The support tools belong to the account's default agent; a turn by anyone else is refused. */
async function supportOnly(ctx: ToolContext): Promise<{ provider: string; modelId: string } | { error: string }> {
  const [me] = await ctx.store
    .select({ kind: agents.kind, provider: agents.provider, modelId: agents.modelId })
    .from(agents)
    .where(and(eq(agents.id, ctx.agentId), eq(agents.accountId, ctx.accountId)));
  if (me?.kind !== "support") return { error: "This tool is not available to you." };
  return { provider: me.provider, modelId: me.modelId };
}

/**
 * Lets an agent created with only a name write its own role, voice and job.
 * Why: the create form asks for a name and nothing else, so the agent finds
 * out what the person wants by asking and then records it. It works once:
 * after that the profile is the person's to edit.
 */
async function executeSetMyProfile(ctx: ToolContext, input: Record<string, unknown>) {
  const [me] = await ctx.store
    .select({ jobDescription: agents.jobDescription })
    .from(agents)
    .where(and(eq(agents.id, ctx.agentId), eq(agents.accountId, ctx.accountId)));
  if (!me || !isUnsetAgent(me)) {
    return { error: "Your profile is already set. The person changes it from your info page." };
  }
  const parsed = ownProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error:
        "Invalid set_my_profile input. Required: role, personality (at least 10 characters), jobDescription (at least 20 characters). Optional: kind (work or companion).",
    };
  }
  await updateAgentFlags(ctx.store, ctx.accountId, ctx.agentId, parsed.data);
  return {
    saved: true,
    note: "This is your job from now on. Tell the person in a line or two what you will do for them, then offer a first step.",
  };
}

async function executeSetBrief(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = accountBriefInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Write the whole brief, between 10 and 4,000 characters." };
  const copied = copiedContextSections(parsed.data.brief);
  if (copied.length > 0) {
    return {
      error: `The brief repeats parts of your own context (${copied.join(", ")}). Every agent already gets those separately, so a copy shows them twice, and it goes stale. Remove those sections and send the brief again.`,
    };
  }
  const saved = await saveBrief(ctx.store, ctx.accountId, parsed.data.brief);
  return { saved: true, characters: saved.length, note: "Every agent on this account reads this brief from its next turn." };
}

/** Section names every agent's context already has; a brief must not carry its own copy. */
const CONTEXT_SECTIONS = ["Now", "Memory", "Profile", "Summary", "Recall", "Work in progress", "Recent work", "Room", "Person"];

/**
 * Headings in a brief that copy sections of the agent's own context.
 * Why: the brief once carried "## Now", "## Memory" and an old "## Profile",
 * so every agent saw two of each, the older one contradicting the newer.
 * Input: the brief text. Output: the copied section names, empty when clean.
 */
export function copiedContextSections(brief: string): string[] {
  const found = new Set<string>();
  for (const match of brief.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const title = match[1]!.trim().toLowerCase();
    const hit = CONTEXT_SECTIONS.find((name) => name.toLowerCase() === title);
    if (hit) found.add(hit);
  }
  return [...found];
}

/**
 * Creates a top-level agent with its own private chat.
 * Why: the support agent writes the job description from what it learned, so
 * the person never faces an empty instructions field. The new agent runs on
 * the caller's model, which the account is known to hold a key for.
 */
async function executeHireAgent(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = hireAgentInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error:
        "Invalid hire_agent input. Required: name, role, kind (work or companion), personality (at least 10 characters), jobDescription (at least 20 characters).",
    };
  }
  let agent: Awaited<ReturnType<typeof createAgent>>;
  try {
    agent = await createAgent(ctx.db, ctx.accountId, {
      name: parsed.data.name,
      label: parsed.data.name,
      role: parsed.data.role,
      personality: parsed.data.personality,
      jobDescription: parsed.data.jobDescription,
      kind: parsed.data.kind,
      provider: me.provider,
      modelId: me.modelId,
    });
  } catch (error) {
    if (error instanceof AgentNameError) return { error: `An agent called "${parsed.data.name}" already exists. Pick another name.` };
    throw error;
  }
  const room = await createRoom(ctx.db, ctx.accountId, {
    kind: "direct",
    title: agent.label,
    ownerAgentId: agent.id,
    memberAgentIds: [],
  });
  // A work agent needs its computer profile; if the computer is still starting, its first chat sets it up.
  if (agent.kind === "work") await createProfile(ctx.store, ctx.accountId, agent.id).catch(noted("Setting up a hired agent's computer profile"));
  const card = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    blocks: [{ kind: "widget", widget: "agent-card", props: { agentId: agent.id, label: agent.label, name: agent.name } }],
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(card);
  await ctx.emit({ type: "message", message: card });
  // The new agent opens its own chat, so the person finds a hello waiting, not an empty screen.
  if (room) {
    startFirstHello(ctx.db, {
      accountId: ctx.accountId,
      conversationId: room.id,
      agentId: agent.id,
      kind: agent.kind,
      generate: ctx.generate,
      skillsRoot: ctx.skillsRoot,
    });
  }
  return {
    agentId: agent.id,
    name: agent.name,
    kind: agent.kind,
    conversationId: room?.id ?? null,
    note: `${agent.label} now has their own chat with the person and is writing a first message there. A card linking to it was posted here.`,
  };
}

async function executeReadAgentMemory(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = agentMemoryReadInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Give the agent's name." };
  const target = await otherAgentByName(ctx, parsed.data.agent);
  if ("error" in target) return target;
  const facts = await agentFacts(ctx.store, ctx.accountId, target.id);
  return {
    agent: target.label,
    facts: facts.map((fact) => ({ kind: fact.kind, subject: fact.subject, body: fact.body })),
    note: "These are the facts only this agent keeps. It also reads the Brief and every fact shared with the whole account.",
  };
}

async function executeRememberForAgent(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = agentMemoryAddInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Give the agent's name and the fact (3 to 1,000 characters)." };
  const target = await otherAgentByName(ctx, parsed.data.agent);
  if ("error" in target) return target;
  const saved = await remember(ctx.db, ctx.accountId, {
    scope: "agent",
    agentId: target.id,
    body: parsed.data.body,
    messageId: await memorySourceId(ctx),
    kind: parsed.data.kind,
    subject: parsed.data.subject,
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(noted("Embedding new summaries"));
  return { memoryId: saved.id, agent: target.label, body: saved.body };
}

async function executeCorrectAgentMemory(ctx: ToolContext, input: Record<string, unknown>) {
  const me = await supportOnly(ctx);
  if ("error" in me) return me;
  const parsed = agentMemoryCorrectInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Give the agent's name, the old fact exactly as read_agent_memory shows it, and the replacement." };
  const target = await otherAgentByName(ctx, parsed.data.agent);
  if ("error" in target) return target;
  const known = await agentFacts(ctx.store, ctx.accountId, target.id);
  if (!known.some((fact) => fact.body === parsed.data.oldBody)) {
    return { error: `${target.label} keeps no fact with that exact text. Call read_agent_memory and copy the fact as it is written.` };
  }
  const saved = await correct(ctx.db, ctx.accountId, {
    scope: "agent",
    agentId: target.id,
    oldBody: parsed.data.oldBody,
    body: parsed.data.body,
    messageId: await memorySourceId(ctx),
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(noted("Embedding new summaries"));
  return { memoryId: saved.id, agent: target.label, body: saved.body };
}

export async function executeEnableTools(ctx: ToolContext, input: Record<string, unknown>) {
  const set = String(input.set ?? "");
  if (!isRequestableToolSet(set)) return { error: "Unknown tool set. Use team, routines, or admin." };
  (ctx.enabledToolSets ??= new Set()).add(set);
  return { enabled: set, tools: toolNamesInSet(set), guidance: toolSetGuidance(set) };
}

/**
 * Connects Instagram or TikTok for this agent, one step per call.
 * The message for the person (hidden fields for the keys, the sign-in link)
 * is posted here, by the server. The agent is told only what happened and
 * what to do next, so no key and no sign-in address passes through the model.
 */
async function executeConnectSocial(ctx: ToolContext, input: Record<string, unknown>) {
  // The connection belongs to the agent the person is talking to, also when a helper makes the call.
  const { show, ...answer } = await connectSocial(ctx.db, ctx.accountId, ctx.voiceAgentId ?? ctx.agentId, input);
  if (!show) return answer;
  const sent = (await executeSendMessage(ctx, { blocks: show })) as { error?: string };
  return sent.error ? { error: `The message could not be shown to the person: ${sent.error}` } : answer;
}

export const dispatcherExecutors: Record<string, ToolExecutor> = {
  connect_social: executeConnectSocial,
  enable_tools: executeEnableTools,
  search_memory: executeSearchMemory,
  send_message: executeSendMessage,
  react_to_message: executeReact,
  notify_user: executeNotify,
  read_history: executeReadHistory,
  remember_fact: executeRememberFact,
  correct_memory: executeCorrectMemory,
  read_skill: executeReadSkill,
  list_skills: (ctx, input) => executeListSkills(ctx, input),
  refresh_skills: (ctx) => executeRefreshSkills(ctx),
  hire_subagent: executeHireSubagent,
  update_teammate: executeUpdateTeammate,
  list_team: (ctx) => listTeam(ctx.store, ctx.accountId, ctx.agentId),
  add_to_group: executeAddToGroup,
  todo_write: (ctx, input) =>
    todoWrite(
      ctx.store,
      ctx.accountId,
      ctx.agentId,
      input.todos as { content: string; status: "pending" | "in_progress" | "completed" }[],
    ),
  todo_list: (ctx) => todoList(ctx.store, ctx.accountId, ctx.agentId),
  create_group: async (ctx, input) => {
    let parsed: ReturnType<typeof groupCreateInputSchema.parse>;
    try {
      parsed = groupCreateInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          error:
            'Invalid create_group input. Required: { "title": "Group name" }. memberIds is optional (omit or []); use agent UUIDs from list_team, not names — add members later with add_to_group.',
        };
      }
      throw error;
    }
    const room = await createGroupRoom(ctx.store, {
      accountId: ctx.accountId,
      ownerAgentId: ctx.agentId,
      title: parsed.title,
      memberIds: parsed.memberIds,
    });
    if (parsed.brief) {
      await ctx.store.update(conversations).set({ brief: parsed.brief }).where(eq(conversations.id, room.id));
    }
    return {
      conversationId: room.id,
      title: room.title,
      members: room.members.length,
      ...(parsed.brief ? {} : { note: "No brief yet. After hiring, call set_team_brief so every teammate knows the goal and how work moves." }),
    };
  },
  message_agent: executeMessageAgent,
  set_my_profile: executeSetMyProfile,
  set_brief: executeSetBrief,
  fire_agent: executeFireAgent,
  hire_agent: executeHireAgent,
  read_agent_memory: executeReadAgentMemory,
  remember_for_agent: executeRememberForAgent,
  correct_agent_memory: executeCorrectAgentMemory,
  set_team_brief: async (ctx, input) => {
    const brief = String(input.brief ?? "").trim();
    if (brief.length < 10) return { error: "Write the brief: the goal, who does what, how work is handed on, where files live." };
    const target = await resolveGroupTarget(ctx, typeof input.conversationId === "string" ? input.conversationId : undefined, "add_to_group");
    if ("error" in target) return target;
    const [room] = await ctx.store
      .select({ ownerAgentId: conversations.ownerAgentId, kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, target.conversationId), eq(conversations.accountId, ctx.accountId)));
    if (!room || room.kind !== "group") return { error: "That is not a group room." };
    if (room.ownerAgentId !== ctx.agentId) return { error: "Only the lead of a group writes its brief." };
    await ctx.store.update(conversations).set({ brief: brief.slice(0, 6_000) }).where(eq(conversations.id, target.conversationId));
    return { saved: true, conversationId: target.conversationId, note: "Every teammate now sees this brief in the group." };
  },
  spawn_worker: executeSpawnWorker,
  redirect_worker: executeRedirectWorker,
  check_worker: executeCheckWorker,
  stop_worker: (ctx, input) => stopWorker(ctx.store, ctx.accountId, String(input.workerId)),
  create_routine: async (ctx, input) => {
    const routine = await createOwnRoutine(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      title: String(input.title),
      instructions: String(input.instructions),
      cron: String(input.cron),
      timezone: typeof input.timezone === "string" ? input.timezone : "UTC",
      runAs: (input.runAs as "worker" | "agent" | undefined) ?? "worker",
      kind: input.kind as string | undefined,
      skills: input.skills as string[] | undefined,
      briefFile: input.briefFile as string | undefined,
    });
    if (routine.briefPath && (await readAgentFile(ctx.accountId, ctx.linuxProfile ?? null, routine.briefPath).catch(() => null)) === null) {
      return { routineId: routine.id, title: routine.title, nextRunAt: routine.nextRunAt, warning: `${routine.briefPath} does not exist yet. Write the brief there before the first run.` };
    }
    return { routineId: routine.id, title: routine.title, runsAs: routine.runsAs, nextRunAt: routine.nextRunAt };
  },
  update_routine: async (ctx, input) => {
    const updated = await updateOwnRoutine(ctx.store, ctx.accountId, ctx.agentId, {
      routineId: String(input.routineId),
      title: input.title as string | undefined,
      instructions: input.instructions as string | undefined,
      cron: input.cron as string | undefined,
      timezone: input.timezone as string | undefined,
      paused: input.paused as boolean | undefined,
      runAs: input.runAs as "worker" | "agent" | undefined,
      kind: input.kind as string | undefined,
      skills: input.skills as string[] | undefined,
      briefFile: input.briefFile as string | undefined,
    });
    if (!updated) throw new Error("No routine of yours with that id.");
    return { routineId: updated.id, title: updated.title, nextRunAt: updated.nextRunAt, paused: updated.paused };
  },
  delete_routine: async (ctx, input) => {
    const parsed = routineIdSchema.parse({ routineId: input.routineId });
    const deleted = await deleteOwnRoutine(ctx.store, ctx.accountId, ctx.agentId, parsed.routineId);
    if (!deleted) throw new Error("No routine of yours with that id.");
    return { deleted: true };
  },
  delete_routines: async (ctx, input) => {
    const parsed = deleteRoutinesInputSchema.parse(input);
    return deleteOwnRoutines(ctx.store, ctx.accountId, ctx.agentId, {
      all: parsed.all === true,
      routineIds: parsed.routineIds,
    });
  },
  list_routines: (ctx) => listOwnRoutines(ctx.store, ctx.accountId, ctx.agentId),
  list_groups: (ctx) => listGroupRoomsForAgent(ctx.store, ctx.accountId, ctx.agentId),
  delete_group: async (ctx, input) => {
    let parsed: ReturnType<typeof groupConversationInputSchema.parse>;
    try {
      parsed = groupConversationInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        return { error: 'Invalid delete_group input. Required: { "conversationId": "<group uuid from list_groups>" }.' };
      }
      throw error;
    }
    // Approval gate: deleting a group with its history is irreversible. The
    // model must ask the person first and re-call with confirmed:true — the
    // turn asking the question ends without deleting anything.
    if (parsed.confirmed !== true) {
      return {
        error:
          "Deleting a group is irreversible. First send_message what will be deleted and ask. Only re-call delete_group with confirmed:true after the person says yes.",
      };
    }
    try {
      return await deleteGroupRoom(ctx.db, {
        accountId: ctx.accountId,
        ownerAgentId: ctx.agentId,
        conversationId: parsed.conversationId,
        activeConversationId: ctx.conversationId,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : "delete_group failed." };
    }
  },
};
