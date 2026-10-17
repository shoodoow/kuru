/**
 * Dispatcher/delegate model loop — only entry to runModelHarness for chat agents.
 * DB: none directly; tools persist via registry executors.
 */
import type { getDb, Store } from "../db/client.js";
import type { TurnEvent } from "../rooms/send-message.js";
import type { messages } from "../db/schema.js";
import type { AgentMode, GenerateResult, TurnInput } from "./types.js";
import { ensureTracePlugins } from "./trace/bootstrap.js";
import { createTraceSession } from "./trace/plugins.js";
import { runModelHarness, type HarnessUsage } from "./trace/harness.js";
import { shouldRetryStall, stallNudge } from "./narration-stall.js";
import { saveSendMessage } from "../rooms/send-message.js";
import {
  CLOSING_TOOLS,
  FOLLOW_THROUGH_TOOLS,
  announcesUnsentCard,
  asksInPlainText,
  claimsWorkInProgress,
  finalTextIsReply,
  promisesUnstartedWork,
  replyOnlyRestriction,
  shouldEndTurn,
  stripLeakedThinking,
} from "./loop-control.js";
import { prompt } from "../prompt/prompts.js";
import { activeDispatcherTools } from "./tools/tool-sets.js";
import { MAX_MODEL_STEPS_DISPATCHER } from "./constants.js";
import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { agents, delegations } from "../db/schema.js";
import { isWorkerLive } from "../rooms/subagents.js";
import { buildFullToolSet } from "./tools/registry.js";
import type { ToolContext } from "./tools/context.js";

type Db = ReturnType<typeof getDb>;

export async function runAgentLoop(
  db: Db,
  store: Store,
  input: TurnInput & {
    conversationId: string;
    runId: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    emit: (event: TurnEvent) => Promise<void>;
    viaAgentId?: string | null;
    delegationDepth?: number;
    mode?: AgentMode;
    /** Optional tool sets that start on for this turn. */
    toolSets?: string[];
    /** Tools withheld for this turn whatever sets are on. */
    blockedTools?: string[];
    /** When set, the only tools this agent has (companion and support agents). */
    allowedTools?: readonly string[];
    /** The default agent: a question to the person must go out as a tappable card. */
    askWithCards?: boolean;
    /** Hidden wake (worker result, routine): no ack owed, silence allowed. */
    hiddenTurn?: boolean;
    /** Ending with no reply is a valid answer here (a reaction), so an empty ending is not retried. */
    quietOk?: boolean;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
  },
): Promise<GenerateResult> {
  ensureTracePlugins();
  const mode = input.mode ?? "dispatcher";
  const traceSession = createTraceSession({
    traceId: randomUUID(),
    runId: input.runId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    mode,
    provider: input.provider,
    modelId: input.modelId,
  });
  const toolCtx: ToolContext = {
    db,
    store,
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    runId: input.runId,
    skillsRoot: input.skillsRoot,
    nextTime: input.nextTime,
    emittedMessages: input.emittedMessages,
    emit: input.emit,
    viaAgentId: input.viaAgentId ?? null,
    delegationDepth: input.delegationDepth,
    generate: input.generate,
    traceSession,
    linuxProfile: input.linuxProfile,
    voiceAgentId: input.agentId,
    hiddenTurn: input.hiddenTurn ?? false,
    enabledToolSets: new Set(input.toolSets ?? []),
    ...(mode === "dispatcher" ? { pluginGates: new Map<string, string>(), pluginLoaders: new Map<string, string>() } : {}),
  };
  const tools = await buildFullToolSet(mode, toolCtx);
  if (input.allowedTools) {
    // Removed outright, not just hidden, so connector and plugin tools cannot be called either.
    const allowed = new Set(input.allowedTools);
    for (const name of Object.keys(tools)) if (!allowed.has(name)) delete tools[name];
  }
  // The person hears first: a line the model writes beside its first tool call
  // ("Checking the site now") is posted before the tool runs. Only once per
  // turn, only when someone is waiting, and only if nothing was sent yet.
  let ledIn = false;
  const onLeadIn =
    mode === "dispatcher" && !input.hiddenTurn
      ? async (raw: string): Promise<void> => {
          const line = stripLeakedThinking(raw).trim();
          if (ledIn || !line || input.emittedMessages.length > 0) return;
          ledIn = true;
          const saved = await saveSendMessage(store, {
            accountId: input.accountId,
            conversationId: input.conversationId,
            agentId: input.agentId,
            runId: input.runId,
            blocks: [{ kind: "text", markdown: line }],
            createdAt: input.nextTime(),
          });
          input.emittedMessages.push(saved);
          await input.emit({ type: "message", message: saved });
        }
      : undefined;
  const harnessInput = {
    ...input,
    onLeadIn,
    db,
    mode,
    tools,
    traceSession,
    shouldStop: (stepToolNames: string[][]) =>
      Boolean(toolCtx.endTurn) ||
      (mode === "dispatcher" &&
        shouldEndTurn({
          stepToolNames,
          handedOff: Boolean(toolCtx.handedOff),
          sentMessage: input.emittedMessages.length > 0,
          hiddenTurn: Boolean(toolCtx.hiddenTurn),
        })),
    activeTools: () =>
      activeDispatcherTools(Object.keys(tools), toolCtx.enabledToolSets ?? new Set(), new Set(input.blockedTools ?? []), {
        gates: toolCtx.pluginGates,
        loaders: toolCtx.pluginLoaders,
      }),
    restrictStep:
      mode === "dispatcher"
        ? (finishedSteps: number, _hardCap: number, stepToolNames: string[][]) => {
            // A new step starts: its calls are counted from zero.
            toolCtx.stepCalls = 0;
            return replyOnlyRestriction({
              stuck: Boolean(toolCtx.stuck),
              finishedSteps,
              maxSteps: MAX_MODEL_STEPS_DISPATCHER,
              stepToolNames,
              handedOff: Boolean(toolCtx.handedOff),
              sentMessage: input.emittedMessages.length > 0,
              hiddenTurn: Boolean(toolCtx.hiddenTurn),
            });
          }
        : undefined,
  };
  const first = await runModelHarness(harnessInput);
  let { text, cacheReadTokens, usage } = first;
  let stepToolNames = first.stepToolNames;
  let responseMessages: unknown[] = [...first.responseMessages];
  if (
    mode === "dispatcher" &&
    shouldRetryStall({
      attempt: 0,
      text,
      // An emoji back is a whole reply.
      sentMessage: input.emittedMessages.length > 0 || stepToolNames.some((names) => names.includes("react_to_message")),
      ended: Boolean(toolCtx.endTurn) || (Boolean(toolCtx.handedOff) && Boolean(toolCtx.hiddenTurn)) || Boolean(input.quietOk),
    })
  ) {
    // Continue the same transcript: tool work already done stays visible, so
    // the retry costs one short reply instead of redoing the whole turn.
    const retry = await runModelHarness({
      ...harnessInput,
      maxSteps: Math.min(2, MAX_MODEL_STEPS_DISPATCHER),
      // The nudge says to stop working; without this the retry went back to
      // reading files and searching, then blamed its tools.
      restrictStep: () => ({ activeTools: [...CLOSING_TOOLS], note: "" }),
      messages: [...input.messages, ...first.responseMessages, { role: "user", content: stallNudge() }] as never,
    });
    text = retry.text;
    stepToolNames = [...stepToolNames, ...retry.stepToolNames];
    cacheReadTokens = retry.cacheReadTokens;
    usage = addUsage(usage, retry.usage);
    responseMessages = [...responseMessages, { role: "user", content: stallNudge() }, ...retry.responseMessages];
  }
  text = stripLeakedThinking(text);
  // An agent with no worker tools (the default agent, a companion) keeps its
  // own promises: "let me save that" with no call gets the turn continued,
  // with all of its tools, instead of ending on a promise.
  const canStartWork = FOLLOW_THROUGH_TOOLS.some((name) => name in tools);
  if (
    mode === "dispatcher" &&
    !canStartWork &&
    !toolCtx.endTurn &&
    input.emittedMessages.length === 0 &&
    // No call at all this turn: a turn that did save something and then says
    // "I'll keep it updated" has nothing left to make true.
    stepToolNames.every((names) => names.length === 0) &&
    !/\blet me know\b/i.test(text) &&
    promisesUnstartedWork({ text, handedOff: false, hiddenTurn: false })
  ) {
    const nudge = prompt("dispatcher", "keep-your-word", { said: text.slice(0, 500) });
    const more = await runModelHarness({
      ...harnessInput,
      maxSteps: 4,
      messages: [...input.messages, ...responseMessages, { role: "user", content: nudge }] as never,
    });
    usage = addUsage(usage, more.usage);
    cacheReadTokens = more.cacheReadTokens ?? cacheReadTokens;
    stepToolNames = [...stepToolNames, ...more.stepToolNames];
    responseMessages = [...responseMessages, { role: "user", content: nudge }, ...more.responseMessages];
    // What was promised is done now, so the reply is whatever followed it.
    if (more.text.trim() || input.emittedMessages.length > 0) text = stripLeakedThinking(more.text);
  }
  const sentThisTurn = input.emittedMessages.length > 0;
  // A card that did go out stands; text that only describes it again is dropped by the speaker.
  const repair = sentThisTurn
    ? null
    : announcesUnsentCard(text)
      ? "card-not-sent"
      : input.askWithCards && !toolCtx.handedOff && asksInPlainText(text)
        ? "ask-as-card"
        : null;
  if (mode === "dispatcher" && !toolCtx.endTurn && "send_message" in tools && repair) {
    // One more step that must call send_message, so the card is actually sent.
    const nudge = prompt("dispatcher", repair);
    const step = (toolChoice?: "required") =>
      runModelHarness({
        ...harnessInput,
        maxSteps: 1,
        shouldStop: () => true,
        toolChoice,
        restrictStep: () => ({ activeTools: ["send_message"], note: "" }),
        messages: [...input.messages, ...responseMessages, { role: "user", content: nudge }] as never,
      });
    // Not every provider accepts a forced tool call; those get the plain nudge.
    const fix = await step("required").catch(() => step());
    usage = addUsage(usage, fix.usage);
    cacheReadTokens = fix.cacheReadTokens ?? cacheReadTokens;
    stepToolNames = [...stepToolNames, ...fix.stepToolNames];
    responseMessages = [...responseMessages, { role: "user", content: nudge }, ...fix.responseMessages];
    // The card, with its lead-in, is the reply now; the text it replaces is dropped.
    if (input.emittedMessages.length > 0) text = "";
  }
  const handedOffInTurn = Boolean(toolCtx.handedOff);
  const said = text.trim() || (input.emittedMessages.at(-1)?.body ?? "");
  if (
    mode === "dispatcher" &&
    !toolCtx.endTurn &&
    canStartWork &&
    promisesUnstartedWork({ text: said, handedOff: Boolean(toolCtx.handedOff), hiddenTurn: Boolean(toolCtx.hiddenTurn) })
  ) {
    // The reply stands as written. This step only makes the promise true.
    const follow = await runModelHarness({
      ...harnessInput,
      maxSteps: 1,
      shouldStop: () => true,
      restrictStep: () => ({ activeTools: [...FOLLOW_THROUGH_TOOLS], note: "" }),
      messages: [
        ...input.messages,
        ...responseMessages,
        { role: "user", content: prompt("dispatcher", "follow-through", { said: said.slice(0, 500) }) },
      ] as never,
    });
    usage = addUsage(usage, follow.usage);
    cacheReadTokens = follow.cacheReadTokens ?? cacheReadTokens;
  }
  // "It's still rendering" is only allowed to stand when something is running.
  let corrected = false;
  if (
    mode === "dispatcher" &&
    !toolCtx.endTurn &&
    !toolCtx.handedOff &&
    canStartWork &&
    claimsWorkInProgress(said) &&
    !(await hasWorkRunning(db, input))
  ) {
    const fix = await runModelHarness({
      ...harnessInput,
      maxSteps: 1,
      shouldStop: () => true,
      restrictStep: () => ({ activeTools: [...FOLLOW_THROUGH_TOOLS], note: "" }),
      messages: [
        ...input.messages,
        ...responseMessages,
        { role: "user", content: prompt("dispatcher", "nothing-running", { said: said.slice(0, 500) }) },
      ] as never,
    });
    usage = addUsage(usage, fix.usage);
    cacheReadTokens = fix.cacheReadTokens ?? cacheReadTokens;
    // Work was started: what was said is now true. Otherwise the honest line replaces it.
    if (!toolCtx.handedOff) {
      const honest = fix.text.trim();
      text = honest && !/^ok\.?$/i.test(honest) ? honest : prompt("dispatcher", "stopped-message");
      corrected = true;
    }
  }
  const handedOffNow = Boolean(toolCtx.handedOff);
  return {
    text,
    cacheReadTokens,
    usage,
    // Handing off ends the turn; text after that is never the answer.
    workLog: toolCtx.workEntries ?? [],
    finalTextIsReply: corrected || (!handedOffInTurn && !handedOffNow && finalTextIsReply(stepToolNames)),
    quiet: !corrected && handedOffInTurn && Boolean(toolCtx.hiddenTurn),
  };
}

/**
 * Whether anything is really running for this agent in this chat.
 * A background worker counts only while its run is alive in this process; a
 * teammate's request counts while it is recent.
 */
async function hasWorkRunning(db: Db, input: { accountId: string; conversationId: string; agentId: string }): Promise<boolean> {
  const rows = await db
    .select({ id: delegations.id, hidden: agents.hidden })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, input.accountId),
        eq(delegations.parentAgentId, input.agentId),
        eq(delegations.status, "running"),
        gt(delegations.heartbeatAt, new Date(Date.now() - 4 * 60 * 60 * 1000)),
      ),
    )
    .catch(() => []);
  return rows.some((row) => (row.hidden ? isWorkerLive(row.id) : true));
}

function addUsage(left: HarnessUsage, right: HarnessUsage): HarnessUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: addNullable(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: addNullable(left.cacheWriteTokens, right.cacheWriteTokens),
    reasoningTokens: addNullable(left.reasoningTokens, right.reasoningTokens),
    steps: left.steps + right.steps,
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/** Legacy single-shot path for tests that bypass tools. */
export async function replyWithModel(db: Db, input: TurnInput): Promise<GenerateResult> {
  ensureTracePlugins();
  const { text, cacheReadTokens, usage } = await runModelHarness({
    ...input,
    db,
    conversationId: "",
    runId: "",
    mode: "dispatcher",
    tools: {},
    maxSteps: 1,
  });
  return { text, cacheReadTokens, usage };
}
