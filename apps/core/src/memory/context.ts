import { createHash } from "node:crypto";
import { buildAgentIdentity, buildInstructions, type AgentIdentity } from "../prompt/build-instructions.js";
import { prompt } from "../prompt/prompts.js";
import { isToolSetName, toolSetGuidance } from "../turn/tools/tool-sets.js";

const keyOrder = ["decisions", "actions", "open", "entities", "corrections", "topics"];

/**
 * Memory budget for one prompt. These caps are what keep the prompt the same
 * size in year three as in week one: storage grows, the prompt does not.
 */
const PROFILE_CHARS = 1_500;
const BRIEF_CHARS = 4_000;
const MEMORY_LINES = 24;
const SUMMARY_DIGESTS = 6;
const SUMMARY_LINES = 12;

/**
 * How a turn ends, placed last in the prefix so it is the freshest standing
 * rule the model reads. Text: prompts/dispatcher.md.
 */
export const turnRule = (): string => prompt("dispatcher", "turn-rule");

export type PersonContext = {
  name: string;
  timezone: string;
  now: Date;
  teammates: { id?: string; label: string; role: string; mention: string }[];
  groups?: { id: string; title: string; memberCount?: number; owned?: boolean }[];
  /** The person's other agents: not teammates, reachable with message_agent. */
  others?: { name?: string; label: string; role: string }[];
};

export type BuiltContext = {
  prefix: string;
  tail: string;
  anthropic: {
    prefix: { cacheControl: { type: "ephemeral" } };
    tail: { body: string };
  };
  openai: {
    promptCacheKey: string;
    promptCacheRetention: "24h";
  };
};

/**
 * Splits one turn into a cacheable prefix and an append-only tail.
 * Why: the prefix (system + identity + optional skills catalog) is byte-stable
 * for provider caching; tool names/schemas live on the AI SDK tools argument,
 * not duplicated here. The tail (room line, summary, messages) changes every turn.
 * Input: account/agent ids, prompt version, identity, summary items, recent
 * work history, optional skills catalog/room. Recent chat messages are sent
 * through the model message channel and are deliberately not duplicated here.
 * Output: prefix + tail plus provider cache hints.
 */
export function buildContext(input: {
  accountId: string;
  agentId: string;
  promptVersion: number;
  identity: AgentIdentity;
  summary: { key: string; body: string; messageId?: string; level?: number }[];
  messages: { body: string }[];
  memories?: { body: string; subject?: string | null }[];
  /** The account's brief: who the person is and what they do, written by the support agent. */
  brief?: string | null;
  /** Pinned standing description of the person and their world. */
  profile?: string | null;
  recall?: string[];
  catalog?: string;
  /** Optional tool sets on from the start of this turn; their guidance joins the prefix. */
  toolSets?: string[];
  room?: { title: string; kind: string; members: string[]; selfName: string };
  person?: PersonContext;
  activeWorkers?: {
    childAgentId: string;
    label?: string | null;
    task: string;
    progress?: string | null;
    createdAt?: Date | null;
    heartbeatAt?: Date | null;
  }[];
  workHistory?: { kind: "worker" | "routine"; title: string; outcome: string; status: string; createdAt: Date; workerId?: string }[];
  /** Team brief, the other room's latest lines, and requests that failed to start. */
  team?: string;
  /** Specs of the agent's own computer, so it never asks the person about them. */
  computer?: string;
}): BuiltContext {
  const isCompanionOrSupport = input.identity.kind === "companion" || input.identity.kind === "support";
  const extras = [
    ...(input.toolSets ?? []).filter(isToolSetName).map((set) => toolSetGuidance(set)),
    ...(!isCompanionOrSupport && input.catalog ? [`${prompt("dispatcher", "skills-heading")}\n${input.catalog}`] : []),
    ...(!isCompanionOrSupport ? [turnRule()] : []),
  ];
  const prefix = [buildInstructions(input.identity), ...extras].join("\n\n");
  const summaryLines = [...input.summary].sort(
    (left, right) => keyOrder.indexOf(left.key) - keyOrder.indexOf(right.key) || left.body.localeCompare(right.body),
  );
  const memoryBlock = memorySection(input.memories ?? []);
  const recallBlock = recallSection(input.recall ?? []);
  // Only an agent that can start work is told what is (or is not) running.
  const workersBlock = input.activeWorkers ? activeWorkersSection(input.activeWorkers) : "";
  const workBlock = workHistorySection(input.workHistory ?? []);
  const summaryBlock = summarySection(summaryLines);
  // Slow-changing blocks first, per-turn blocks last: a provider that caches
  // by prefix can then reuse the stable part of the tail too. The clock,
  // which changes every minute, sits at the very end.
  const tail = [
    ...(input.room ? [`## Room\n${roomLine(input.room)}`] : []),
    ...(input.person ? [`## Person\n${personBlock(input.person)}`] : []),
    ...(input.computer?.trim() ? [`## Your computer\n${prompt("dispatcher", "computer-facts", { facts: input.computer.trim() })}`] : []),
    ...(input.brief?.trim() ? [`## Brief\n${prompt("dispatcher", "brief", { brief: nestHeadings(clipAtWord(input.brief.trim(), BRIEF_CHARS)) })}`] : []),
    ...(input.profile?.trim() ? [`## Profile\n${nestHeadings(clipAtWord(input.profile.trim(), PROFILE_CHARS))}`] : []),
    ...(memoryBlock ? [`## Memory\n${memoryBlock}`] : []),
    ...(summaryBlock ? [`## Summary\n${summaryBlock}`] : []),
    ...(recallBlock ? [`## Recall\n${recallBlock}`] : []),
    ...(workersBlock ? [`## Work in progress\n${workersBlock}`] : []),
    ...(workBlock ? [`## Recent work\n${workBlock}`] : []),
    ...(input.team?.trim() ? [`## Team\n${input.team.trim()}`] : []),
    ...(input.person ? [`## Now\n${clockLine(input.person)}`] : []),
  ].join("\n\n");
  return {
    prefix,
    tail,
    anthropic: {
      prefix: { cacheControl: { type: "ephemeral" } },
      tail: { body: tail },
    },
    openai: {
      promptCacheKey: cacheKey(input.accountId, input.agentId, input.promptVersion),
      promptCacheRetention: "24h",
    },
  };
}

/**
 * Renders the composed identity block for non-turn paths (workers, delegates).
 * Why: single choke point so background prompts match chat prompts exactly.
 * Input: an agent row with role/personality/jobDescription.
 * Output: the identity block text.
 */
export function identityBlock(agent: {
  name: string;
  role: string;
  personality: string;
  jobDescription: string;
}): string {
  return buildAgentIdentity({
    name: agent.name,
    role: agent.role,
    personality: agent.personality ?? "",
    job: agent.jobDescription,
  });
}

/**
 * Renders the room situation as the first tail line.
 * Why: without it the model does not know the room name, who shares it, or
 * which member it is — the exact confusion behind "Looks like you're asking
 * @Jimmy" written BY Jimmy. One factual line grounds identity, roster, and
 * the @mention rule every turn. Lives in the tail (dynamic), never the
 * cached prefix.
 * Input: room title/kind, member names, own name. Output: one header line.
 */
export function roomLine(room: { title: string; kind: string; members: string[]; selfName: string }): string {
  const title = room.title.replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
  const members = room.members.length > 0 ? room.members.slice(0, 20).join(", ") : "—";
  const shape = room.kind === "group" ? `group of ${room.members.length}` : "direct chat";
  return `"${title}" (${shape}). Members: ${members}. You are ${room.selfName}.`;
}

/**
 * Names the human, their clock, and the account roster separately.
 * Why: a group otherwise treats other agents as the audience, and a private
 * chat otherwise sees no team at all (members of the 1:1 only). Teammates and
 * groups are account-level here so the model can reuse them without extra
 * list_team/list_groups calls. Generic: no example names, just the roster with
 * copy-pasteable UUIDs. Lives in the dynamic tail, never the cached prefix.
 * Input: account name, zone, instant, teammate labels+ids, group ids+titles.
 * Output: one tail block.
 */
export function personLine(person: PersonContext): string {
  return `${personBlock(person)}\n${clockLine(person)}`;
}

/** Person + account roster as one block; buildContext splits it under ## headers. */
function personBlock(person: PersonContext): string {
  const name = person.name.trim() || "the person";
  const teammates =
    person.teammates.length === 0
      ? "Team: none."
      : `Team:\n${person.teammates.slice(0, 10).map((mate) => `- ${formatTeammate(mate)}`).join("\n")}${person.teammates.length > 10 ? `\n+${person.teammates.length - 10} more` : ""}`;
  const groups =
    person.groups === undefined
      ? ""
      : person.groups.length === 0
        ? "\nGroups: none."
        : `\nGroups:\n${person.groups
            .slice(0, 10)
            .map((group) => `- "${group.title.replace(/\s+/g, " ").trim().slice(0, 60)}" (id:${group.id}${typeof group.memberCount === "number" ? `, ${group.memberCount} members` : ""})`)
            .join("\n")}${person.groups.length > 10 ? `\n+${person.groups.length - 10} more` : ""}`;
  const others =
    person.others && person.others.length > 0
      ? `\nOther agents (each has its own chat with the person; pass one a message with message_agent): ${person.others
          .slice(0, 12)
          .map((other) => otherAgentLine(other))
          .join("; ")}`
      : "";
  return `Person: ${name}. You speak to them. They are not a teammate.\n${teammates}${groups}${others}`;
}

/** The person's clock. Kept apart from the roster because it changes every minute. */
function clockLine(person: PersonContext): string {
  const local = formatLocalTime(person.now, person.timezone);
  return local
    ? `Timezone: ${person.timezone.trim()}. Local time now: ${local}.`
    : "Timezone: unknown. Do not invent one.";
}

function formatTeammate(mate: { id?: string; label: string; role: string; mention: string }): string {
  const label = mate.label.replace(/\s+/g, " ").trim().slice(0, 40) || mate.mention;
  const role = mate.role.replace(/\s+/g, " ").trim().slice(0, 40) || "teammate";
  const mention = mate.mention.trim().slice(0, 80);
  return mate.id ? `${label} (${role}, @${mention}, id:${mate.id})` : `${label} (${role}, mention @${mention})`;
}

function formatLocalTime(now: Date, timezone: string): string | null {
  const zone = timezone.trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(now);
  } catch {
    return null;
  }
}

/**
 * One other agent as "Name, title: role".
 * Why: only the title was shown, cut at 30 characters ("Sets up your agents
 * and keeps "), while the brief and memories call agents by name ("Sam owns
 * the shop"), so the agent could not tell who was who.
 */
function otherAgentLine(other: { name?: string; label: string; role: string }): string {
  const tidy = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const name = tidy(other.name);
  const label = tidy(other.label);
  const role = tidy(other.role);
  const head = name && label && name.toLowerCase() !== label.toLowerCase() ? `${name}, ${label}` : name || label;
  return role && role.toLowerCase() !== label.toLowerCase() ? `${head}: ${clipAtWord(role, 90)}` : head;
}

/** Longest saved fact shown in the prompt. */
const MEMORY_LINE_CHARS = 900;

/**
 * Shortens text at a word boundary and marks the cut.
 * Why: plain slicing ended lines mid-word ("portfolio pie", "keeps )"), which
 * reads as garbage and hides that something was left out.
 * Input: text and the longest length. Output: the text, or its start plus "…".
 */
export function clipAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(—-]+$/, "")}…`;
}

/**
 * Turns the headings inside written text into bold lines.
 * Why: the brief is a document the support agent writes, and it had its own
 * "## Memory", "## Profile" and "## Now" headings. In the prompt they looked
 * exactly like the real sections, so an agent saw two of each and could not
 * tell where the brief ended or which profile was current.
 * Input: markdown text. Output: the same text with no line starting with #.
 */
export function nestHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, "**$1**");
}

/**
 * Renders durable facts as a standing memory block in the tail.
 * Why: remembered facts (user + this agent's own) must re-enter the model's
 * context every turn or the agent "forgets" across a long-running thread. They
 * live in the dynamic tail, not the cached prefix, because they change as the
 * agent learns and corrects. Empty input renders nothing.
 * Input: the facts to surface. Output: a labeled block, or empty string.
 */
function memorySection(memories: { body: string; subject?: string | null }[]): string {
  if (memories.length === 0) {
    return "";
  }
  return memories
    .slice(0, MEMORY_LINES)
    .map((memory) => {
      // Was 300 characters: a fact listing four rules lost the last two.
      const body = clipAtWord(memory.body.replace(/\s+/g, " ").trim(), MEMORY_LINE_CHARS);
      return `- ${memory.subject?.trim() ? `${memory.subject.trim()}: ` : ""}${body}`;
    })
    .join("\n");
}

/**
 * Renders the semantically-recalled slice of older context in the tail.
 * Why: on a long thread the relevant past is pulled back by similarity rather
 * than scrolling the whole transcript, so the agent stays sharp without the
 * window growing. Empty input renders nothing.
 */
function recallSection(recall: string[]): string {
  if (recall.length === 0) {
    return "";
  }
  return recall
    .slice(0, 8)
    .map((line) => `- ${line.replace(/\s+/g, " ").trim().slice(0, 420)}`)
    .join("\n");
}

/** One running worker per line: facts only, no coaching (rules live in prefix). */
export function activeWorkersSection(
  workers: {
    childAgentId: string;
    label?: string | null;
    task: string;
    progress?: string | null;
    createdAt?: Date | null;
    /** Last sign of life from the worker. */
    heartbeatAt?: Date | null;
  }[],
  now: Date = new Date(),
): string {
  // Said outright, so "it is still running" is never asserted from memory.
  if (workers.length === 0) {
    return "Nothing is running right now. Any work you mentioned earlier has stopped or finished; see Recent work.";
  }
  const minutes = (from?: Date | null): string => {
    if (!from) return "";
    const value = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
    return value < 1 ? "under a minute" : `${value} min`;
  };
  return workers
    .slice(0, 5)
    .map((w) => {
      const name = (w.label?.trim() || w.childAgentId).slice(0, 40);
      const progress = w.progress?.trim() ? ` — ${w.progress.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
      const started = w.createdAt ? `, running for ${minutes(w.createdAt)}` : "";
      const active = w.heartbeatAt ? `, last active ${minutes(w.heartbeatAt)} ago` : "";
      return `- ${name} (id:${w.childAgentId}${started}${active}): ${w.task.replace(/\s+/g, " ").trim().slice(0, 120)}${progress}`;
    })
    .join("\n");
}

/**
 * Renders a bounded cross-thread record of the employee's recent work.
 * Why: a long-lived CMO must remember what its workers and routines actually
 * accomplished without replaying old chats or injecting raw execution logs.
 * Input: recent completed work selected by the caller. Output: a concise,
 * labeled block in newest-first order.
 */
export function workHistorySection(
  history: { kind: "worker" | "routine"; title: string; outcome: string; status: string; createdAt: Date; workerId?: string }[],
): string {
  if (history.length === 0) return "";
  const lines = history.slice(0, 3).map((item) => {
    const title = item.title.replace(/\s+/g, " ").trim().slice(0, 100);
    const outcome = cleanOutcome(item.outcome).slice(0, 240);
    // The id is what `redirect_worker` needs to continue that same job.
    const id = item.workerId ? ` (id:${item.workerId})` : "";
    return `- ${item.kind} ${item.status}${id}: ${title}${outcome ? ` — ${outcome}` : ""}`;
  });
  return lines.join("\n");
}

/** Tool-digest soup (bash:/HTML/JSON blobs) carries no signal — keep the head only. */
function cleanOutcome(outcome: string): string {
  const text = outcome.replace(/\s+/g, " ").trim();
  if (/^(bash:|<!DOCTYPE|<html|[{"\[])/i.test(text)) return text.slice(0, 80);
  return text.slice(0, 200);
}

/**
 * Folded history, long arc first: year and month digests, then recent slice lines.
 * Message ids are kept so read_history can open the exact wording.
 */
function summarySection(summary: { key: string; body: string; messageId?: string; level?: number }[]): string {
  if (summary.length === 0) return "";
  const digests = summary.filter((item) => (item.level ?? 0) > 0).slice(-SUMMARY_DIGESTS);
  const slices = summary.filter((item) => (item.level ?? 0) === 0).slice(0, SUMMARY_LINES);
  return [
    ...digests.map((item) => `- ${item.body.replace(/\s+/g, " ").trim().slice(0, 900)}`),
    ...slices.map(
      (item) =>
        `- ${item.key}: ${item.body.replace(/\s+/g, " ").trim().slice(0, 300)}${item.messageId ? ` [msg:${item.messageId}]` : ""}`,
    ),
  ].join("\n");
}

function cacheKey(accountId: string, agentId: string, promptVersion: number): string {
  const raw = `${accountId}:${agentId}:${promptVersion}`;
  if (raw.length <= 64) {
    return raw;
  }
  return createHash("sha256").update(raw).digest("hex");
}
