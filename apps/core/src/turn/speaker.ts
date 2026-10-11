/**
 * One agent speaks in a turn (context load → model loop → mention chain).
 * DB: reads messages/summary; writes messages via tools or stub path.
 */
import { isWorkerLive } from "../rooms/subagents.js";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, agents, conversations, delegations, jobs, messages, reactions, routines, summaryItems } from "../db/schema.js";
import { buildContext, type PersonContext } from "../memory/context.js";
import { stallMessage } from "./narration-stall.js";
import { briefFor, factsAboutMentioned, memoriesFor, profileFor } from "../memory/memory.js";
import { recallHits } from "../memory/recall.js";
import { hitLine } from "../memory/search.js";
import { accountHome, createProfile } from "../linux/linux.js";
import { fileBlocksFromText, inlineSharedOutputBlocks } from "../rooms/uploads.js";
import { RECENT_WINDOW, SUMMARY_WINDOW } from "./constants.js";
import { propose } from "../skills/proposals.js";
import { skillCatalogForAgent } from "../skills/agent-skills.js";
import { blocksToText, mirrorGroupSpeechToOwnerDm, type TurnEvent } from "../rooms/send-message.js";
import { runAgentLoop } from "./agent-loop.js";
import { teamContextFor } from "./team-chat.js";
import { computerFacts } from "../computer/computer.js";
import { isUnsetAgent } from "../roster/roster.js";
import { allowedForKind, initialToolSets, TEAM_MEMBER_BLOCKED } from "./tools/tool-sets.js";
import { recentWorkLogs, saveWorkLog, weaveWorkLogs } from "./work-log.js";
import { mentionedAgents } from "./mentions.js";
import { replaySentCards, toModelMessages, type ReplyParent } from "./prompt-media.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { tailSlice, unwrapGenerateResult } from "./util.js";
import { createTraceSession } from "./trace/plugins.js";
import { randomUUID } from "node:crypto";
import { noted } from "../log/logger.js";

type Db = ReturnType<typeof getDb>;

export async function speakOnce(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    memberRows: { id: string; name: string; label?: string; role?: string }[];
    room: { title: string; kind: string; ownerAgentId?: string | null; brief?: string | null };
    skillsRoot?: string;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
    nextTime: () => Date;
    runId: string;
    emit: (event: TurnEvent) => Promise<void>;
    saved: (typeof messages.$inferSelect)[];
    queue: (string | undefined)[];
    spoken: Set<string>;
    cue?: string;
    /** "routine" when a schedule woke the agent; turns the routines tool set on. */
    runKind?: "turn" | "routine";
    /**
     * Per-run usage accumulator (mutated). Survives years-long threads:
     * each speaker adds its harness usage; orchestrator persists the sum.
     * Stub-generate test turns contribute nothing.
     */
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; steps: number };
  },
): Promise<void> {
  const { accountId, conversationId, agentId, memberRows, room, skillsRoot, generate, nextTime, runId, emit, saved, queue, spoken, cue, usage } =
    input;
  let [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) throw new Error("Agent not found");
  if (!agent.linuxProfile) {
    try {
      await createProfile(db, accountId, agentId);
      const [refreshed] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
      if (refreshed) agent = refreshed;
    } catch {
      // Computer unavailable; chat continues.
    }
  }
  // Recent window only: older turns live in folded summary items, not the prompt,
  // so a years-long thread stays inside the context window and stays sharp.
  const recent = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
      .orderBy(desc(messages.createdAt))
      .limit(RECENT_WINDOW)
  ).reverse();
  // Folded history: the newest slice lines plus the month/year digests that
  // carry the long arc. Everything else is reached by recall or search.
  const sliceSummary = (
    await db
      .select()
      .from(summaryItems)
      .where(
        and(
          eq(summaryItems.conversationId, conversationId),
          eq(summaryItems.accountId, accountId),
          eq(summaryItems.level, 0),
        ),
      )
      .orderBy(desc(summaryItems.createdAt))
      .limit(SUMMARY_WINDOW)
  ).reverse();
  const digests = (
    await db
      .select()
      .from(summaryItems)
      .where(
        and(
          eq(summaryItems.conversationId, conversationId),
          eq(summaryItems.accountId, accountId),
          gt(summaryItems.level, 0),
        ),
      )
      .orderBy(desc(summaryItems.level), desc(summaryItems.periodStart))
      .limit(6)
  ).reverse();
  const summary = [...digests, ...sliceSummary];
  // The query is the latest exchange, not just the last message: "yes, do it"
  // carries no signal on its own.
  const lastUserMessage = [...recent].reverse().find((message) => !message.agentId)?.body ?? cue ?? "";
  const recallQuery = [
    ...recent.slice(-3).map((message) => message.body.slice(0, 600)),
    ...(cue ? [cue.slice(0, 600)] : []),
  ].join("\n");
  const [standing, mentioned, profile, brief] = await Promise.all([
    memoriesFor(db, accountId, agentId),
    factsAboutMentioned(db, accountId, agentId, `${lastUserMessage}\n${recallQuery}`).catch(() => []),
    profileFor(db, accountId).catch(() => null),
    briefFor(db, accountId).catch(() => null),
  ]);
  // Facts about whoever was just named come first; then the newest standing facts.
  const factIds = new Set<string>();
  const facts = [...mentioned, ...standing].filter((fact) => (factIds.has(fact.id) ? false : (factIds.add(fact.id), true)));
  const factBodies = new Set(facts.map((fact) => fact.body));
  const recall = (
    await recallHits(db, { accountId, agentId, conversationId, query: recallQuery || lastUserMessage }).catch(() => [])
  )
    .filter((hit) => !factBodies.has(hit.body) && !facts.some((fact) => hit.body.endsWith(fact.body)))
    .map((hit) => hitLine(hit));
  const catalog = (
    await skillCatalogForAgent({
      skillsRoot,
      accountId,
      linuxProfile: agent.linuxProfile,
    })
  )
    .map((skill) => catalogLine(skill))
    .join("\n");
  // Query active background workers running for this parent agent in this room.
  // This gives the dispatcher full visibility over background tasks so it:
  // 1) Remains available to converse with the user while tasks run.
  // 2) Knows what's in-flight to report status.
  // 3) Can redirect or stop active workers rather than spawning duplicates.
  const runningRows = await db
    .select({
      id: delegations.id,
      hidden: agents.hidden,
      childAgentId: delegations.childAgentId,
      label: agents.label,
      task: delegations.task,
      progress: delegations.progress,
      createdAt: delegations.createdAt,
      heartbeatAt: delegations.heartbeatAt,
    })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, agentId),
        eq(delegations.status, "running"),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(5);
  // A worker row can read "running" with nothing behind it (the system
  // restarted mid-job). Listing it made the agent promise work that was dead.
  const activeWorkers = runningRows.filter((row) => !row.hidden || isWorkerLive(row.id));
  const recentWorkers = await db
    .select({
      title: delegations.task,
      outcome: delegations.result,
      status: delegations.status,
      createdAt: delegations.createdAt,
      workerId: delegations.childAgentId,
    })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, agentId),
        inArray(delegations.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(5);
  const recentRoutines = await db
    .select({
      title: routines.title,
      outcome: jobs.result,
      status: jobs.status,
      createdAt: jobs.runAt,
    })
    .from(jobs)
    .innerJoin(routines, eq(jobs.routineId, routines.id))
    .where(
      and(
        eq(jobs.accountId, accountId),
        eq(routines.agentId, agentId),
        inArray(jobs.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(jobs.runAt))
    .limit(5);
  const seenTasks = new Set<string>();
  const workHistory = [
    ...recentWorkers.map((item) => ({ ...item, kind: "worker" as const, outcome: item.outcome ?? "" })),
    ...recentRoutines.map((item) => ({ ...item, kind: "routine" as const, outcome: item.outcome ?? "" })),
  ]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .filter((item) => {
      const head = item.title.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
      if (seenTasks.has(head)) return false;
      seenTasks.add(head);
      return true;
    })
    .slice(0, 3);

  const person = await loadPerson(db, accountId, agentId);
  const [routineCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(routines)
    .where(and(eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  const teamMember = room.kind === "group" && Boolean(room.ownerAgentId) && room.ownerAgentId !== agent.id;
  const toolSets = initialToolSets({
    agentKind: agent.kind,
    teamMember,
    roomKind: room.kind,
    hasTeam: person.teammates.length > 0 || (person.groups?.length ?? 0) > 0,
    hasRoutines: (routineCount?.count ?? 0) > 0,
    routineWake: input.runKind === "routine",
  });
  const context = buildContext({
    accountId,
    agentId: agent.id,
    promptVersion: agent.promptVersion,
    identity: {
      name: agent.name,
      role: agent.role,
      personality: agent.personality,
      job: agent.jobDescription,
      kind: agent.kind,
    },
    summary: summary.map((item) => ({ key: item.key, body: item.body, messageId: item.messageId, level: item.level })),
    messages: recent.map((message) => ({ body: tailSlice(message.body) })),
    memories: facts.map((fact) => ({ body: fact.body, subject: fact.subject })),
    profile,
    brief,
    recall,
    catalog,
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: agent.name,
    },
    person,
    toolSets,
    activeWorkers,
    workHistory,
    computer: agent.linuxProfile ? await computerFacts(accountId).catch(() => "") : "",
    team: await teamContextFor(db, {
      accountId,
      agentId: agent.id,
      room: { id: conversationId, kind: room.kind, ownerAgentId: room.ownerAgentId ?? null, title: room.title, brief: room.brief },
    }).catch(() => ""),
  });
  const emittedMessages: (typeof messages.$inferSelect)[] = [];
  const replyParents = await loadReplyParents(db, accountId, conversationId, recent);
  // Earlier turns' tool work rides along as private notes, so this turn
  // continues from what was already done instead of rediscovering it.
  const workLogs = recent[0]
    ? await recentWorkLogs(db, { accountId, conversationId, agentId, since: recent[0].createdAt }).catch(() => [])
    : [];
  const reactionRows =
    recent.length > 0
      ? await db
          .select({ messageId: reactions.messageId, emoji: reactions.emoji })
          .from(reactions)
          .where(
            and(
              eq(reactions.accountId, accountId),
              eq(reactions.userKey, "owner"),
              inArray(
                reactions.messageId,
                recent.map((row) => row.id),
              ),
            ),
          )
      : [];
  // Names for everyone who has spoken here, members or mirrored teammates.
  const speakerNames = new Map<string, string>(memberRows.map((member) => [member.id, member.label?.trim() || member.name]));
  const unknownSpeakers = [...new Set(recent.map((row) => row.agentId).filter((id): id is string => Boolean(id)))].filter(
    (id) => !speakerNames.has(id),
  );
  if (unknownSpeakers.length > 0) {
    const rows = await db
      .select({ id: agents.id, name: agents.name, label: agents.label })
      .from(agents)
      .where(and(eq(agents.accountId, accountId), inArray(agents.id, unknownSpeakers)));
    for (const row of rows) speakerNames.set(row.id, row.label?.trim() || row.name);
  }
  const personReactions = new Map<string, string[]>();
  for (const row of reactionRows) {
    personReactions.set(row.messageId, [...(personReactions.get(row.messageId) ?? []), row.emoji]);
  }
  const modelMessages = replaySentCards(
    weaveWorkLogs(
      recent,
      toModelMessages(recent, replyParents, person.timezone, personReactions, {
        selfId: agent.id,
        names: speakerNames,
      }),
      workLogs,
    ),
  );
  if (cue) modelMessages.push({ role: "user", content: cue });
  const useStub = typeof generate === "function";
  const traceSession = createTraceSession({
    traceId: randomUUID(),
    runId,
    accountId,
    conversationId,
    agentId,
    mode: "dispatcher",
    provider: agent.provider,
    modelId: agent.modelId,
  });
  const generateWithStore = useStub
    ? () =>
        (generate as (input: TurnInput) => Promise<GenerateResult>)({
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          messages: modelMessages,
        })
    : () =>
        runAgentLoop(db, db, {
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          conversationId,
          runId,
          skillsRoot,
          nextTime,
          emittedMessages,
          emit,
          messages: modelMessages,
          hiddenTurn: Boolean(cue),
          toolSets,
          blockedTools: [
            ...(teamMember ? TEAM_MEMBER_BLOCKED : []),
            // An agent writes its own profile once, while it still has none.
            ...(isUnsetAgent(agent) ? [] : ["set_my_profile"]),
          ],
          allowedTools: allowedForKind(agent.kind),
          askWithCards: agent.kind === "support",
          generate,
        });
  let result: ReturnType<typeof unwrapGenerateResult>;
  try {
    result = unwrapGenerateResult(await generateWithStore());
    await saveWorkLog(db, { accountId, conversationId, agentId, runId, cue, entries: result.workLog ?? [] }).catch(noted("Saving the work log"));
    if (usage && result.usage) {
      usage.input += result.usage.inputTokens ?? 0;
      usage.output += result.usage.outputTokens ?? 0;
      usage.cacheRead += result.usage.cacheReadTokens ?? 0;
      usage.cacheWrite += result.usage.cacheWriteTokens ?? 0;
      usage.reasoning += result.usage.reasoningTokens ?? 0;
      usage.steps += result.usage.steps ?? 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    void traceSession.emit({ type: "run.error", phase: "model", message: message.slice(0, 500) });
    console.log('error', message);
    result = {
      text: message.startsWith("Add an API key")
        ? message
        : "The model provider failed. Check the provider key, model id, and endpoint.",
      cacheReadTokens: null,
    };
  }
  // Bubbles already sent stand on their own unless the model went on to do
  // more work and answered in plain text afterwards; then that text is posted too.
  const answerAfterBubbles = emittedMessages.length > 0 && Boolean(result.finalTextIsReply) && result.text.trim().length > 0;
  if (emittedMessages.length > 0 && answerAfterBubbles) {
    for (const row of emittedMessages) saved.push(row);
  }
  if (emittedMessages.length > 0 && !answerAfterBubbles) {
    for (const row of emittedMessages) {
      saved.push(row);
    }
    if (result.proposal) {
      await propose(db, accountId, {
        agentId,
        kind: result.proposal.kind,
        body: result.proposal.body,
        messageIds: result.proposal.messageIds,
      });
    }
    const chainSource = emittedMessages
      .filter((m) => !m.viaAgentId)
      .map((m) => m.body)
      .join("\n");
    for (const next of mentionedAgents(chainSource, memberRows, true, agentId)) {
      if (!spoken.has(next) && !queue.includes(next)) queue.push(next);
    }
    return;
  }
  // A hidden wake that started background work has nothing to tell the
  // person yet; text beside that handoff is the agent thinking out loud.
  if (result.quiet) return;
  // Teammates' lines reach the model as "[Name]: ...", and it copies that
  // label onto its own reply. The room already shows who is speaking.
  const raw = stripWidgetEcho(result.text.trim().replace(/^\[[^\]\n]{1,40}\]:\s*/, ""));
  // Models copy the "[file: name (saved at /path)]" form history shows them.
  // Deliver those as real attachments instead of a line of text.
  const parsedReply = fileBlocksFromText(raw);
  const attachments: Awaited<ReturnType<typeof inlineSharedOutputBlocks>> = [];
  const unsent: string[] = [];
  // One file at a time, so one that cannot be sent does not sink the others.
  for (const file of parsedReply.files) {
    try {
      attachments.push(
        ...(await inlineSharedOutputBlocks(
          accountId,
          [{ kind: "file" as const, url: file.url, name: file.name }],
          agent.linuxProfile ? accountHome(accountId, agent.linuxProfile) : undefined,
        )),
      );
    } catch {
      unsent.push(file.name);
    }
  }
  // A file that could not be attached is named plainly; the raw placeholder
  // with its path on the agent's computer means nothing to the person.
  const text = [parsedReply.text, ...unsent.map((name) => `_${name} could not be sent here: it is too large or could not be read._`)]
    .filter(Boolean)
    .join("\n\n");
  // Plain text is a reply. Only a truly empty ending gets the stall line.
  const bodyText = text || (attachments.length > 0 ? "" : stallMessage());
  const payload = [
    ...(bodyText ? [{ kind: "text" as const, markdown: bodyText }] : []),
    ...attachments.filter((block) => block.kind === "file" && (block.url.startsWith("data:") || block.remote)),
  ];
  const [wrapped] = await db
    .insert(messages)
    .values({
      accountId,
      conversationId,
      agentId,
      runId,
      body: blocksToText(payload),
      kind: "rich",
      payload: payload,
      cacheReadTokens: result.cacheReadTokens,
      createdAt: nextTime(),
    })
    .returning();
  saved.push(wrapped!);
  await mirrorGroupSpeechToOwnerDm(db, wrapped!);
  await emit({ type: "message", message: wrapped! });
  if (result.proposal) {
    await propose(db, accountId, {
      agentId,
      kind: result.proposal.kind,
      body: result.proposal.body,
      messageIds: result.proposal.messageIds,
    });
  }
  for (const next of mentionedAgents(bodyText, memberRows, true, agentId)) {
    if (!spoken.has(next) && !queue.includes(next)) queue.push(next);
  }
}

/** Longest skill description shown in the prompt's skill list. */
const CATALOG_DESCRIPTION_CHARS = 110;

/**
 * One skill as a prompt line.
 * Why: a bare name told the model nothing, so it loaded skills just to learn
 * what they were for. A short description lets it pick without reading.
 */
function catalogLine(skill: { name: string; description?: string }): string {
  const description = (skill.description ?? "").replace(/\s+/g, " ").trim();
  if (!description) return `- ${skill.name}`;
  const short =
    description.length > CATALOG_DESCRIPTION_CHARS
      ? `${description.slice(0, CATALOG_DESCRIPTION_CHARS).replace(/\s+\S*$/, "")}…`
      : description;
  return `- ${skill.name}: ${short}`;
}

/**
 * Loads who the person is for this turn's tail.
 * Why: the room roster is agents; the human has to be named separately.
 * Team/groups are account-level so a private chat sees them without extra
 * list_team/list_groups calls. Generic: roster with copy-pasteable UUIDs.
 * Input: account id and the speaking agent. Output: name, zone, now, team, groups.
 */
async function loadPerson(db: Db, accountId: string, agentId: string): Promise<PersonContext> {
  const [account] = await db
    .select({ name: accounts.name, timezone: accounts.timezone })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const { listTeam } = await import("../rooms/subagents.js");
  const { listGroupRoomsForAgent } = await import("../rooms/rooms.js");
  const [team, groups] = await Promise.all([
    listTeam(db, accountId, agentId).catch(() => []),
    listGroupRoomsForAgent(db, accountId, agentId).catch(() => []),
  ]);
  return {
    name: account?.name ?? "the person",
    timezone: account?.timezone ?? "",
    now: new Date(),
    teammates: team.map((member) => ({
      id: member.id,
      label: member.label?.trim() || member.name,
      role: member.role?.trim() || "teammate",
      mention: member.name,
    })),
    groups: groups.map((group) => ({ id: group.conversationId, title: group.title, owned: group.owned })),
    others: await otherAgents(db, accountId, agentId, new Set(team.map((member) => member.id))),
  };
}

/** The person's other top-level agents: those with their own private chat. */
async function otherAgents(
  db: Db,
  accountId: string,
  agentId: string,
  teamIds: Set<string>,
): Promise<{ label: string; role: string }[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
    .from(agents)
    .innerJoin(conversations, and(eq(conversations.ownerAgentId, agents.id), eq(conversations.kind, "direct")))
    .where(and(eq(agents.accountId, accountId), eq(agents.hidden, false)))
    .limit(40);
  const seen = new Set<string>();
  return rows
    .filter((row) => row.id !== agentId && !teamIds.has(row.id) && !seen.has(row.id) && Boolean(seen.add(row.id)))
    .slice(0, 12)
    .map((row) => ({ label: row.label?.trim() || row.name, role: row.role?.trim() ?? "" }));
}

/**
 * Loads reply parents missing from the recent window.
 * Why: a short reply like "yes" needs the quoted parent even if that parent scrolled out of recent.
 */
async function loadReplyParents(
  db: ReturnType<typeof getDb>,
  accountId: string,
  conversationId: string,
  recent: { id?: string; replyTo?: string | null }[],
): Promise<Map<string, ReplyParent>> {
  const known = new Set(recent.map((row) => row.id).filter((id): id is string => Boolean(id)));
  const missing = [
    ...new Set(
      recent
        .map((row) => row.replyTo)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !known.has(id)),
    ),
  ];
  const parents = new Map<string, ReplyParent>();
  if (missing.length === 0) return parents;
  const rows = await db
    .select({ id: messages.id, body: messages.body, agentId: messages.agentId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.conversationId, conversationId),
        inArray(messages.id, missing),
      ),
    );
  for (const row of rows) parents.set(row.id, { body: row.body, agentId: row.agentId });
  return parents;
}

/**
 * Removes a widget written as text from a plain reply.
 * Why: a card exists only when the model calls send_message. Writing its
 * name, or copying how history describes an earlier card, showed the person
 * a line like "[widget:question]" with nothing to tap.
 */
export function stripWidgetEcho(text: string): string {
  return text
    .replace(/\[widget:[a-z][a-z0-9_-]*\s*(\{(?:[^{}]|\{[^{}]*\})*\})?\s*\]/gi, "")
    .replace(/\(Shown to the person as a [^\n]*? card[^\n]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
