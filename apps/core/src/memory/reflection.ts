/**
 * An agent's nightly reflection ("sleep"): it tends memory, checks the
 * health of what the agent carries, and learns from mistakes and rewards.
 *
 * Why: an agent got no better between days. Corrections, praise and failed
 * jobs stayed in old chat lines while memory gathered duplicates and stale
 * facts. Once a day a model reads what happened and proposes small edits.
 *
 * Safety, because a bad night must never make the agent worse:
 * - It runs on the agent's own model (once a day, so the cost is small); the
 *   background model is only a fallback.
 * - The model only proposes. Code checks every edit before it is saved: it
 *   must cite real messages as evidence, may only name skills and tools that
 *   exist, holds no secrets, stays short, and the night has a cap. An edit
 *   that fails a check is dropped, never repaired.
 * - Rules carry strength: one from the person's words is firm, one inferred
 *   from a job is tentative until confirmed; confirmations count up and
 *   contradictions reword or retire it.
 * - Every run is journaled with its exact edits and can be undone.
 * - Health is measured by code from real usage, not judged by the model.
 * - Nothing is judged by word lists. Lines that mean the same are found by
 *   embeddings (when the account has an embedder); whether the person
 *   corrected or praised the agent is read by the model, in any language,
 *   and must point at the person's own messages.
 * - Only the Chief of Staff tends the facts shared by every agent.
 */
import { generateText } from "ai";
import { and, asc, avg, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { toolsForSurface } from "@kuru/agent-tools";
import { emojiTone } from "@kuru/shared";
import type { getDb } from "../db/client.js";
import { accounts, agentReflections, agents, conversations, delegations, memories, messages, reactions, runs, toolApprovals } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { prompt } from "../prompt/prompts.js";
import { backgroundModelFor } from "../rooms/subagents.js";
import { skillCatalogForAgent } from "../skills/agent-skills.js";
import { config } from "../config.js";
import { remember, supersede } from "./memory.js";
import { alikePairs, closestRows, ALIKE_DISTANCE } from "./recall.js";

type Db = ReturnType<typeof getDb>;

/** How often an agent reflects on its own, at most. */
export const REFLECT_EVERY_MS = 20 * 60 * 60 * 1000;
/** The person's local hours when agents reflect on their own: from 2 to before 6 at night. */
export const REFLECT_HOURS = { from: 2, to: 6 } as const;

/** The hour (0-23) it is now in this zone; UTC when the zone is empty or unknown. */
export function localHour(timezone: string, now = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone || "UTC" }).format(now));
  } catch {
    return now.getUTCHours();
  }
}
/**
 * What one agent keeps for itself before it must merge or retire.
 * Why: Nora reached 25 rules and 66 facts. Only a few fit in front of her at
 * once, so the ones that did were whichever were newest, and old rules from
 * earlier directions contradicted the current one. A small set she can hold
 * whole beats a large set she sees a slice of. Enforced, not just advised:
 * over budget, a new line is turned down unless the same reflection frees room.
 */
export const RULE_BUDGET = 12;
export const FACT_BUDGET = 30;
const CONVERSATION_CHARS = 24_000;
const JOB_CHARS = 8_000;
const BODY_CHARS = 300;
const CAPS = { rule: 4, fact: 3, total: 10 };
/** A first step bigger than this is worth looking at. */
const HEAVY_STEP_TOKENS = 45_000;
/**
 * How long one model may think before the reflection gives up on it. A slow
 * reasoning model or a stalled gateway once left a reflection (and the
 * profile's Fix now) waiting with no end; past this the background model
 * tries, with the same limit.
 */
const MODEL_TIMEOUT_MS = 150_000;

export type ReflectionEdit =
  | { op: "rule" | "fact"; body: string; evidence: string[] }
  | { op: "replace"; target: string; body: string; evidence: string[] }
  | { op: "merge"; targets: string[]; body: string }
  | { op: "confirm" | "contradict" | "retire"; target: string; evidence: string[] };

/** An edit after the checks, with what it did to memory, for the journal and for undo. */
export type JournaledEdit = ReflectionEdit & {
  dropped?: string;
  tentative?: boolean;
  created?: string;
  replaced?: string[];
  retired?: string;
  counted?: { id: string; by: number };
};

/** Soft-clips body text at sentence or word boundary to stay within max chars without being dropped. */
export function clipBody(text: string, max = BODY_CHARS): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const sentenceMatch = sliced.match(/^([\s\S]*[.!?])\s+/);
  if (sentenceMatch && sentenceMatch[1] && sentenceMatch[1].length >= 30) {
    return sentenceMatch[1].trim();
  }
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= 30) {
    const cut = sliced.slice(0, lastSpace).trim();
    return /[.!?]$/.test(cut) ? cut : `${cut}.`;
  }
  return sliced.trim();
}

/** Reads the model's lines into edits; anything not in the format is ignored. */
export function parseReflection(text: string): ReflectionEdit[] {
  const edits: ReflectionEdit[] = [];
  const evidenceOf = (tail: string): string[] =>
    [...(/\[([^\]]*)\]\s*$/.exec(tail)?.[1] ?? "").matchAll(/[MJ]\d{1,4}/gi)].map((match) => match[0].toUpperCase());
  const withoutEvidence = (tail: string): string => tail.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-*\s]+/, "").trim();
    if (!line || /^nothing\.?$/i.test(line)) continue;
    let match: RegExpExecArray | null;
    if ((match = /^(rule|fact):\s*(.+)$/i.exec(line))) {
      edits.push({ op: match[1]!.toLowerCase() as "rule" | "fact", body: clipBody(withoutEvidence(match[2]!)), evidence: evidenceOf(match[2]!) });
    } else if ((match = /^replace\s+([RFS]\d{1,3}):\s*(.+)$/i.exec(line))) {
      edits.push({ op: "replace", target: match[1]!.toUpperCase(), body: clipBody(withoutEvidence(match[2]!)), evidence: evidenceOf(match[2]!) });
    } else if ((match = /^merge\s+((?:[RFS]\d{1,3}\s*){2,4}):\s*(.+)$/i.exec(line))) {
      edits.push({ op: "merge", targets: match[1]!.trim().toUpperCase().split(/\s+/), body: clipBody(withoutEvidence(match[2]!)) });
    } else if ((match = /^(confirm|contradict|retire)\s+([RFS]\d{1,3})\b(.*)$/i.exec(line))) {
      edits.push({ op: match[1]!.toLowerCase() as "confirm" | "contradict" | "retire", target: match[2]!.toUpperCase(), evidence: evidenceOf(match[3]!) });
    }
    if (edits.length >= 20) break;
  }
  return edits;
}

type Row = { id: string; body: string; kind: string; confirmed: number; tentative: boolean };

/** What the agent carries and how it is doing, measured from data. */
export type AgentHealth = {
  status: "healthy" | "watch" | "needs attention";
  issues: string[];
  measured: {
    stepTokens: number | null;
    rules: number;
    facts: number;
    tentative: number;
    /** Pairs of lines that mean nearly the same; null when the account has no embedder. */
    duplicates: number | null;
    jobs: number;
    failedJobs: number;
    /** Read at the last reflection: messages where the person corrected it, and praise plus reactions. */
    corrections: number;
    rewards: number;
    lastReflection: string | null;
  };
};

/** How a reaction reads to the reflection model. */
const TONE_WORD = { good: "", bad: " (did not like it)", neutral: " (neutral)" } as const;

/** What the person's messages told the agent, as the model read them: refs of corrections and of praise. */
export function parseSignals(text: string): { corrections: string[]; praise: string[] } {
  const signals = { corrections: [] as string[], praise: [] as string[] };
  for (const raw of text.split("\n")) {
    const match = /^(correction|praise)\b[:\s]*((?:\[?M\d{1,4}\]?[,\s]*)+)$/i.exec(raw.replace(/^[-*\s]+/, "").trim());
    if (!match) continue;
    const refs = [...match[2]!.matchAll(/M\d{1,4}/gi)].map((ref) => ref[0].toUpperCase());
    (match[1]!.toLowerCase() === "praise" ? signals.praise : signals.corrections).push(...refs);
  }
  return { corrections: [...new Set(signals.corrections)], praise: [...new Set(signals.praise)] };
}

/**
 * Measures one agent's health from what it carries and how its day went.
 * No model involved, so the reading itself cannot drift.
 */
export async function measureHealth(
  db: Db,
  accountId: string,
  agentId: string,
  signals?: { corrections: number; rewards: number },
): Promise<AgentHealth> {
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const own = await ownMemory(db, accountId, agentId);
  const rules = own.filter((row) => row.kind === "procedure");
  const facts = own.filter((row) => row.kind !== "procedure" && row.kind !== "profile");
  let duplicates: number | null = 0;
  for (const list of [rules, facts]) {
    const pairs = await alikePairs(db, accountId, list.map((row) => row.id)).catch(() => null);
    duplicates = pairs && duplicates !== null ? duplicates + pairs.length : null;
  }
  const [step] = await db
    .select({ value: avg(sql<number>`${runs.inputTokens}::float / nullif(${runs.modelSteps}, 0)`) })
    .from(runs)
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(and(eq(runs.accountId, accountId), eq(conversations.ownerAgentId, agentId), gt(runs.createdAt, day)));
  const jobs = await db
    .select({ status: delegations.status })
    .from(delegations)
    .where(and(eq(delegations.accountId, accountId), eq(delegations.parentAgentId, agentId), gt(delegations.createdAt, day)));
  const [spoke] = await db
    .select({ value: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.accountId, accountId), eq(conversations.ownerAgentId, agentId), isNull(messages.agentId)));
  const [last] = await db
    .select({ createdAt: agentReflections.createdAt })
    .from(agentReflections)
    .where(and(eq(agentReflections.agentId, agentId), eq(agentReflections.status, "applied")))
    .orderBy(desc(agentReflections.createdAt))
    .limit(1);
  // Corrections and rewards are what the last reflection read, never guessed here.
  const [read] = signals
    ? []
    : await db
        .select({ health: agentReflections.health })
        .from(agentReflections)
        .where(and(eq(agentReflections.agentId, agentId), inArray(agentReflections.status, ["applied", "dry"])))
        .orderBy(desc(agentReflections.createdAt))
        .limit(1);
  const stored = (read?.health as AgentHealth | undefined)?.measured;
  const corrections = signals?.corrections ?? stored?.corrections ?? 0;
  const rewards = signals?.rewards ?? stored?.rewards ?? 0;
  const stepTokens = step?.value ? Math.round(Number(step.value)) : null;
  const failedJobs = jobs.filter((job) => job.status === "failed").length;
  const issues: string[] = [];
  let level = 0;
  const raise = (to: number, issue: string) => {
    level = Math.max(level, to);
    issues.push(issue);
  };
  if (rules.length > RULE_BUDGET) raise(1, `${rules.length} rules, more than ${RULE_BUDGET}: some should be merged.`);
  if (facts.length > FACT_BUDGET) raise(1, `${facts.length} facts, more than ${FACT_BUDGET}: some are outdated.`);
  if (duplicates) raise(1, `${duplicates} pair${duplicates === 1 ? "" : "s"} of rules or facts mean nearly the same.`);
  if (stepTokens && stepTokens > HEAVY_STEP_TOKENS) raise(1, `Each step reads about ${Math.round(stepTokens / 1000)}k tokens, which is heavy.`);
  if (failedJobs >= 2 && failedJobs >= jobs.length / 2) raise(2, `${failedJobs} of ${jobs.length} background jobs failed today.`);
  if (corrections >= 3) raise(1, `You corrected it ${corrections} times before its last reflection.`);
  if (!last && (spoke?.value ?? 0) > 0) raise(1, "It has never reflected on its work.");
  return {
    status: (["healthy", "watch", "needs attention"] as const)[level]!,
    issues,
    measured: {
      stepTokens,
      rules: rules.length,
      facts: facts.length,
      tentative: own.filter((row) => row.tentative).length,
      duplicates,
      jobs: jobs.length,
      failedJobs,
      corrections,
      rewards,
      lastReflection: last?.createdAt.toISOString() ?? null,
    },
  };
}

async function ownMemory(db: Db, accountId: string, agentId: string): Promise<Row[]> {
  return db
    .select({ id: memories.id, body: memories.body, kind: memories.kind, confirmed: memories.confirmed, tentative: memories.tentative })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.scope, "agent"), eq(memories.agentId, agentId), isNull(memories.supersededBy)))
    .orderBy(desc(memories.createdAt))
    .limit(200);
}

const STANDARD_CONTAINER_TOOLS = [
  "ffmpeg",
  "ffprobe",
  "kokoro",
  "af_heart",
  "node",
  "python",
  "python3",
  "git",
  "docker",
  "curl",
  "wget",
  "jq",
  "bash",
  "sh",
  "three",
  "canvas",
  "webaudio",
  "playwright",
  "chrome",
  "chromium",
  "h264",
  "aac",
  "mp4",
  "mp3",
  "wav",
  "npm",
  "pnpm",
  "pip",
  "tar",
  "zip",
  "unzip",
  "grep",
  "sed",
  "awk",
];

/** Names an edit may mention: the agent's skills and every tool. */
async function knownNames(accountId: string, profile: string | null): Promise<Set<string>> {
  const names = new Set<string>(STANDARD_CONTAINER_TOOLS);
  for (const surface of ["dispatcher", "worker"] as const) for (const def of toolsForSurface(surface, { hasLinux: true })) names.add(def.name.toLowerCase());
  const skills = await skillCatalogForAgent({ skillsRoot: config.skillsDir(), accountId, linuxProfile: profile }).catch(() => []);
  for (const skill of skills) names.add(skill.name.toLowerCase());
  return names;
}

const SECRET = /(sk-[A-Za-z0-9_-]{12,}|\bpassword\s*[:=]|\bapi[_ -]?key\s*[:=]|\btoken\s*[:=]\s*\S{12,}|\b[A-Fa-f0-9]{32,}\b)/i;

/** Why an edit's text cannot be saved, or null when it may. */
export function textProblem(body: string, names: Set<string>): string | null {
  if (body.length < 8) return "too short to be useful";
  if (body.length > BODY_CHARS) return `longer than ${BODY_CHARS} characters`;
  if (SECRET.test(body)) return "looks like it holds a secret";
  const mentioned = [...body.matchAll(/`([a-z0-9_.-]{3,60})`|(?:^|\s)\/([a-z0-9_-]{3,60})\b/gi)].map((match) => (match[1] ?? match[2]!).toLowerCase());
  const unknown = mentioned.filter((name) => !names.has(name) && !name.includes("."));
  return unknown.length > 0 ? `names ${unknown.join(", ")}, which this agent does not have` : null;
}

/** What one reflection read, proposed and did. */
export type ReflectionResult = {
  id?: string;
  status: "applied" | "dry" | "skipped";
  read: { messages: number; jobs: number };
  edits: JournaledEdit[];
  applied: number;
  note: string;
  health: AgentHealth;
  before?: { rules: string[]; facts: string[]; shared?: string[] };
};

const QUIET_HEALTH: AgentHealth = {
  status: "healthy",
  issues: [],
  measured: { stepTokens: null, rules: 0, facts: 0, tentative: 0, duplicates: 0, jobs: 0, failedJobs: 0, corrections: 0, rewards: 0, lastReflection: null },
};

/**
 * Reflects for one agent on what happened since `since`.
 * Input: db, ids, and options: `since` (defaults to the last reflection or
 * creation), `dryRun` to propose without saving, `think` to stand in for the
 * model in tests. Output: the result, journaled unless nothing was said.
 */
export async function reflectAgent(
  db: Db,
  accountId: string,
  agentId: string,
  options: { since?: Date; lookBackMs?: number; dryRun?: boolean; think?: (system: string, user: string) => Promise<string> } = {},
): Promise<ReflectionResult> {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) return { status: "skipped", read: { messages: 0, jobs: 0 }, edits: [], applied: 0, note: "No such agent.", health: QUIET_HEALTH };
  // "Reflect now" from the app reads at least the last few days: after an undo, or
  // with nothing said since the nightly run, it otherwise had nothing to read.
  const last = agent.reflectedAt ?? agent.createdAt;
  const since =
    options.since ??
    (options.lookBackMs ? new Date(Math.min(last.getTime(), Date.now() - options.lookBackMs)) : last);
  const rooms = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.accountId, accountId), eq(conversations.ownerAgentId, agentId)));
  const roomIds = rooms.map((room) => room.id);
  const said = roomIds.length
    ? await db
        .select({ id: messages.id, agentId: messages.agentId, body: messages.body, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, roomIds), gt(messages.createdAt, since)))
        .orderBy(asc(messages.createdAt))
        .limit(400)
    : [];
  const health = await measureHealth(db, accountId, agentId);
  const fromPerson = said.filter((row) => !row.agentId);
  if (fromPerson.length === 0) {
    return {
      status: "skipped",
      read: { messages: said.length, jobs: 0 },
      edits: [],
      applied: 0,
      note: options.lookBackMs ? "Nothing to learn: the person has not written to it in the last few days." : "Nothing new from the person since the last reflection.",
      health,
    };
  }

  // Rewards ride on the line they were given to.
  const taps = await db
    .select({ messageId: reactions.messageId, emoji: reactions.emoji })
    .from(reactions)
    .where(and(eq(reactions.accountId, accountId), isNull(reactions.agentId), inArray(reactions.messageId, said.map((row) => row.id))));
  const tapsOf = new Map<string, string[]>();
  for (const tap of taps) tapsOf.set(tap.messageId, [...(tapsOf.get(tap.messageId) ?? []), tap.emoji]);
  const decided = await db
    .select({ status: toolApprovals.status, summary: toolApprovals.summary })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.accountId, accountId), eq(toolApprovals.agentId, agentId), gt(toolApprovals.createdAt, since), inArray(toolApprovals.status, ["approved", "denied"])))
    .limit(30);
  const jobs = await db
    .select({ status: delegations.status, task: delegations.task, result: delegations.result })
    .from(delegations)
    .where(and(eq(delegations.accountId, accountId), eq(delegations.parentAgentId, agentId), gt(delegations.createdAt, since)))
    .orderBy(asc(delegations.createdAt))
    .limit(40);

  const own = await ownMemory(db, accountId, agentId);
  const rules = own.filter((row) => row.kind === "procedure");
  const facts = own.filter((row) => row.kind !== "procedure" && row.kind !== "profile").slice(0, 100);
  // Only the Chief of Staff tends what every agent shares.
  const tendsShared = agent.kind === "support";
  const shared: Row[] = tendsShared
    ? await db
        .select({ id: memories.id, body: memories.body, kind: memories.kind, confirmed: memories.confirmed, tentative: memories.tentative })
        .from(memories)
        .where(and(eq(memories.accountId, accountId), eq(memories.scope, "user"), isNull(memories.supersededBy), sql`${memories.kind} <> 'profile'`))
        .orderBy(desc(memories.createdAt))
        .limit(80)
    : [];

  // Messages are numbered so every edit can cite them; the newest that fit are kept.
  const numbered = said.map((row, index) => ({ ...row, ref: `M${index + 1}` }));
  const lines = numbered.map((row) => {
    const tapped = tapsOf.get(row.id);
    const body = row.body.replace(/\s+/g, " ").trim().slice(0, row.agentId ? 600 : 3_000);
    const read = tapped?.map((emoji) => `${emoji}${TONE_WORD[emojiTone(emoji)]}`).join(" ");
    return `${row.ref} ${row.agentId ? agent.name : "Person"}: ${body}${read ? ` [the person reacted ${read}]` : ""}`;
  });
  // With an embedder, lines that mean nearly the same are pointed out; the model decides.
  // Without one the model still sees every line and merges what it finds.
  const keyOf = new Map<string, string>();
  rules.forEach((row, index) => {
    keyOf.set(row.id, `R${index + 1}`);
  });
  facts.forEach((row, index) => {
    keyOf.set(row.id, `F${index + 1}`);
  });
  shared.forEach((row, index) => {
    keyOf.set(row.id, `S${index + 1}`);
  });
  const alike: string[] = [];
  for (const list of [rules, facts, shared]) {
    const pairs = await alikePairs(db, accountId, list.map((row) => row.id)).catch(() => null);
    for (const [a, b] of pairs ?? []) alike.push(`${keyOf.get(a)} and ${keyOf.get(b)}`);
  }
  const render = (list: Row[], letter: string) =>
    list.length
      ? list.map((row, index) => `${letter}${index + 1}${row.tentative ? " (tentative)" : ""}${row.confirmed ? ` (confirmed ${row.confirmed}x)` : ""}: ${row.body}`).join("\n")
      : "(none)";
  const user = prompt("memory", "reflect-user", {
    name: agent.name,
    role: agent.role,
    rules: render(rules, "R"),
    facts: render(facts, "F"),
    shared: tendsShared ? `\nFacts every agent shares (you tend these):\n${render(shared, "S")}\n` : "",
    budgets: `Keep at most ${RULE_BUDGET} rules and ${FACT_BUDGET} facts; it has ${rules.length} and ${facts.length}.`,
    alike: alike.length ? `\nThese look alike by meaning; merge each pair that says the same, leave the ones that differ:\n${alike.map((pair) => `- ${pair}`).join("\n")}\n` : "",
    conversation: fitFromEnd(lines, CONVERSATION_CHARS) || "(none)",
    jobs:
      fitFromEnd(
        jobs.map((job, index) => `- J${index + 1} [${job.status}] ${job.task.replace(/\s+/g, " ").slice(0, 200)} → ${(job.result ?? "no report").replace(/\s+/g, " ").slice(0, 600)}`),
        JOB_CHARS,
      ) || "(none)",
    decisions: decided.map((row) => `- ${row.status}: ${row.summary.slice(0, 160)}`).join("\n") || "(none)",
  });
  const text = options.think ? await options.think(prompt("memory", "reflect"), user) : await callModel(db, accountId, agent, user);

  // Code checks every proposal before anything is saved.
  const names = await knownNames(accountId, agent.linuxProfile);
  const jobRefs = jobs.map((_, index) => `J${index + 1}`);
  const validRefs = new Set([...numbered.map((row) => row.ref), ...jobRefs]);
  const personRefs = new Set(numbered.filter((row) => !row.agentId).map((row) => row.ref));
  const pick = (target: string): Row | undefined => {
    const list = target.startsWith("R") ? rules : target.startsWith("F") ? facts : shared;
    return list[Number(target.slice(1)) - 1];
  };
  const added = { rule: 0, fact: 0, total: 0 };
  const journal: JournaledEdit[] = [];
  for (const edit of parseReflection(text)) {
    const entry: JournaledEdit = { ...edit };
    journal.push(entry);
    const evidence = "evidence" in edit ? edit.evidence.filter((ref) => validRefs.has(ref)) : [];
    if ("evidence" in edit && evidence.length === 0) {
      entry.dropped = "cites no message it read";
      continue;
    }
    if ("body" in edit) {
      const problem = textProblem(edit.body, names);
      if (problem) {
        entry.dropped = problem;
        continue;
      }
    }
    const targets = edit.op === "merge" ? edit.targets : "target" in edit ? [edit.target] : [];
    if (targets.some((target) => !pick(target))) {
      entry.dropped = "points at a line that does not exist";
      continue;
    }
    if (targets.some((target) => target.startsWith("S")) && !tendsShared) {
      entry.dropped = "only the Chief of Staff edits shared facts";
      continue;
    }
    if (added.total >= CAPS.total || ((edit.op === "rule" || edit.op === "fact") && added[edit.op] >= CAPS[edit.op])) {
      entry.dropped = "over tonight's limit of changes";
      continue;
    }
    entry.tentative = !evidence.some((ref) => personRefs.has(ref));
    added.total += 1;
    if (edit.op === "rule" || edit.op === "fact") added[edit.op] += 1;
  }

  // A new line that repeats one the agent has is turned down: identical text
  // always, and close in meaning when an embedder can tell.
  const fresh = journal.filter((entry): entry is JournaledEdit & { op: "rule" | "fact"; body: string } => !entry.dropped && (entry.op === "rule" || entry.op === "fact"));
  const same = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const entry of fresh) {
    const list = entry.op === "rule" ? rules : facts;
    const twin = list.findIndex((row) => same(row.body) === same(entry.body));
    if (twin >= 0) entry.dropped = `already there as ${entry.op === "rule" ? "R" : "F"}${twin + 1}`;
  }
  for (const kind of ["rule", "fact"] as const) {
    const list = kind === "rule" ? rules : facts;
    const left = fresh.filter((entry) => entry.op === kind && !entry.dropped);
    const near = await closestRows(db, accountId, left.map((entry) => entry.body), list.map((row) => row.id)).catch(() => null);
    near?.forEach((hit, index) => {
      if (hit && hit.distance < ALIKE_DISTANCE) left[index]!.dropped = `means nearly the same as ${keyOf.get(hit.id)}; confirm or replace that instead`;
    });
  }

  // Over budget, a new line needs room made in the same pass: a retire, or a merge of several into one.
  for (const kind of ["rule", "fact"] as const) {
    const prefix = kind === "rule" ? "R" : "F";
    const kept = journal.filter((entry) => !entry.dropped);
    const freed =
      kept.filter((entry) => entry.op === "retire" && entry.target.startsWith(prefix)).length +
      kept.reduce((sum, entry) => sum + (entry.op === "merge" ? Math.max(0, entry.targets.filter((target) => target.startsWith(prefix)).length - 1) : 0), 0);
    let room = (kind === "rule" ? RULE_BUDGET : FACT_BUDGET) - (kind === "rule" ? rules : facts).length + freed;
    for (const entry of kept) {
      if (entry.op !== kind) continue;
      if (room <= 0) entry.dropped = `over the budget of ${kind === "rule" ? RULE_BUDGET : FACT_BUDGET} ${kind}s; merge or retire one first`;
      else room -= 1;
    }
  }

  // What the person's words meant is the model's reading, held to their own messages.
  const labels = parseSignals(text);
  const agentRefs = new Set(numbered.filter((row) => row.agentId).map((row) => row.ref));
  // A reaction counts by its tone: 👎 is a complaint, 👀 is neither.
  const tapsWith = (tone: string) =>
    numbered.filter((row) => agentRefs.has(row.ref) && (tapsOf.get(row.id) ?? []).some((emoji) => emojiTone(emoji) === tone)).length;
  const signals = {
    corrections: labels.corrections.filter((ref) => personRefs.has(ref)).length + tapsWith("bad"),
    rewards: labels.praise.filter((ref) => personRefs.has(ref)).length + tapsWith("good"),
  };

  const read = { messages: said.length, jobs: jobs.length };
  const before = { rules: rules.map((row) => row.body), facts: facts.map((row) => row.body), shared: shared.map((row) => row.body) };
  if (options.dryRun) {
    const proposed = await measureHealth(db, accountId, agentId, signals);
    const note = noteFor(journal, proposed);
    const [row] = await db
      .insert(agentReflections)
      .values({ accountId, agentId, status: "dry", health: proposed as unknown as Record<string, unknown>, edits: journal, note })
      .returning({ id: agentReflections.id });
    return { id: row?.id, status: "dry", read, edits: journal, applied: 0, note, health: proposed, before };
  }

  const source = fromPerson.at(-1)!.id;
  let applied = 0;
  for (const entry of journal) {
    if (entry.dropped) continue;
    try {
      await applyEdit(db, accountId, agentId, entry, pick, source);
      applied += 1;
    } catch (error) {
      entry.dropped = `could not be saved: ${error instanceof Error ? error.message.slice(0, 80) : "error"}`;
    }
  }
  const after = await measureHealth(db, accountId, agentId, signals);
  const note = noteFor(journal, after);
  const [row] = await db
    .insert(agentReflections)
    .values({ accountId, agentId, status: "applied", health: after as unknown as Record<string, unknown>, edits: journal, note })
    .returning({ id: agentReflections.id });
  await db.update(agents).set({ reflectedAt: new Date() }).where(eq(agents.id, agentId));
  return { id: row?.id, status: "applied", read, edits: journal, applied, note, health: after, before };
}

/** Saves one checked edit and records on it what it changed, for undo. */
async function applyEdit(
  db: Db,
  accountId: string,
  agentId: string,
  entry: JournaledEdit,
  pick: (target: string) => Row | undefined,
  source: string,
): Promise<void> {
  if (entry.op === "rule" || entry.op === "fact") {
    const saved = await remember(db, accountId, { scope: "agent", agentId, kind: entry.op === "rule" ? "procedure" : "fact", body: entry.body, messageId: source });
    await db.update(memories).set({ tentative: Boolean(entry.tentative) }).where(eq(memories.id, saved.id));
    entry.created = saved.id;
  } else if (entry.op === "replace" || entry.op === "merge") {
    const keys = entry.op === "merge" ? entry.targets : [entry.target];
    const olds = keys.map((target) => pick(target)!);
    const isShared = keys[0]!.startsWith("S");
    const saved = await remember(db, accountId, {
      scope: isShared ? "user" : "agent",
      agentId: isShared ? null : agentId,
      kind: olds[0]!.kind,
      body: entry.body,
      messageId: source,
    });
    // A better wording keeps the strength of what it replaces.
    await db
      .update(memories)
      .set({ confirmed: olds.reduce((sum, old) => sum + old.confirmed, 0), tentative: olds.every((old) => old.tentative) && Boolean(entry.tentative) })
      .where(eq(memories.id, saved.id));
    for (const old of olds) if (old.id !== saved.id) await supersede(db, accountId, old.id, saved.id);
    entry.created = saved.id;
    entry.replaced = olds.map((old) => old.id);
  } else if (entry.op === "confirm") {
    const row = pick(entry.target)!;
    await db.update(memories).set({ confirmed: row.confirmed + 1, ...(entry.tentative ? {} : { tentative: false }) }).where(eq(memories.id, row.id));
    entry.counted = { id: row.id, by: 1 };
  } else if (entry.op === "contradict") {
    const row = pick(entry.target)!;
    // Contradicted with nothing confirming it: it goes. Otherwise it loses a point.
    if (row.confirmed <= 0) {
      await supersede(db, accountId, row.id, row.id);
      entry.retired = row.id;
    } else {
      await db.update(memories).set({ confirmed: row.confirmed - 1 }).where(eq(memories.id, row.id));
      entry.counted = { id: row.id, by: -1 };
    }
  } else if (entry.op === "retire") {
    const row = pick(entry.target)!;
    await supersede(db, accountId, row.id, row.id);
    entry.retired = row.id;
  }
}

/** One plain line for the profile: what changed and how the agent is doing. */
function noteFor(journal: JournaledEdit[], health: AgentHealth): string {
  const kept = journal.filter((entry) => !entry.dropped);
  const countOf = (ops: string[]) => kept.filter((entry) => ops.includes(entry.op)).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    countOf(["rule"]) ? `learned ${plural(countOf(["rule"]), "rule")}` : "",
    countOf(["fact"]) ? `kept ${plural(countOf(["fact"]), "new fact")}` : "",
    countOf(["replace", "merge"]) ? `tidied ${countOf(["replace", "merge"])}` : "",
    countOf(["confirm"]) ? `confirmed ${countOf(["confirm"])}` : "",
    countOf(["retire", "contradict"]) ? `retired ${countOf(["retire", "contradict"])}` : "",
  ].filter(Boolean);
  const dropped = journal.length - kept.length;
  const step = health.measured.stepTokens ? ` About ${Math.round(health.measured.stepTokens / 1000)}k tokens a step.` : "";
  const body = parts.length ? `${parts.join(", ")}.` : "Nothing to change.";
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}${dropped ? ` ${dropped} proposed change${dropped === 1 ? " was" : "s were"} turned down by the checks.` : ""}${step}`;
}

/**
 * Undoes one applied reflection: what it created is retired, what it replaced
 * or retired comes back, and counts it moved go back.
 */
export async function undoReflection(db: Db, accountId: string, reflectionId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(agentReflections)
    .where(and(eq(agentReflections.id, reflectionId), eq(agentReflections.accountId, accountId), eq(agentReflections.status, "applied")));
  if (!row) return false;
  for (const entry of [...(row.edits as JournaledEdit[])].reverse()) {
    if (entry.dropped) continue;
    if (entry.created) await db.update(memories).set({ supersededBy: entry.created }).where(and(eq(memories.id, entry.created), eq(memories.accountId, accountId)));
    for (const id of entry.replaced ?? []) await db.update(memories).set({ supersededBy: null }).where(and(eq(memories.id, id), eq(memories.accountId, accountId)));
    if (entry.retired) await db.update(memories).set({ supersededBy: null }).where(and(eq(memories.id, entry.retired), eq(memories.accountId, accountId)));
    if (entry.counted) {
      await db
        .update(memories)
        .set({ confirmed: sql`${memories.confirmed} - ${entry.counted.by}` })
        .where(and(eq(memories.id, entry.counted.id), eq(memories.accountId, accountId)));
    }
  }
  await db.update(agentReflections).set({ status: "undone" }).where(eq(agentReflections.id, reflectionId));
  return true;
}

/** The latest journaled reflections of one agent, newest first. */
export async function recentReflections(db: Db, accountId: string, agentId: string, limit = 5) {
  return db
    .select()
    .from(agentReflections)
    .where(and(eq(agentReflections.accountId, accountId), eq(agentReflections.agentId, agentId)))
    .orderBy(desc(agentReflections.createdAt))
    .limit(limit);
}

/** The newest lines that fit, kept in order. */
function fitFromEnd(lines: string[], chars: number): string {
  const kept: string[] = [];
  let room = chars;
  for (const line of [...lines].reverse()) {
    if (line.length > room) break;
    room -= line.length + 1;
    kept.unshift(line);
  }
  return kept.join("\n");
}

/** The agent's own model first, once a day; the background model when that fails. */
async function callModel(db: Db, accountId: string, agent: typeof agents.$inferSelect, user: string): Promise<string> {
  const run = async (provider: string, modelId: string, apiKey: string, baseUrl?: string | null) =>
    (
      await generateText({
        model: getModel(provider, modelId, apiKey, baseUrl),
        instructions: [{ role: "system" as const, content: prompt("memory", "reflect") }],
        messages: [{ role: "user", content: user }],
        abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      })
    ).text ?? "";
  try {
    const credential = await keyFor(db, accountId, agent.provider);
    return await run(agent.provider, agent.modelId, credential.apiKey, credential.baseUrl);
  } catch {
    const fallback = await backgroundModelFor(db, accountId, agent);
    return run(fallback.provider, fallback.modelId, fallback.credential.apiKey, fallback.credential.baseUrl);
  }
}

/**
 * Reflects for the agents that are due, a few per call.
 * Due: a visible agent that has not reflected for REFLECT_EVERY_MS, whose
 * chats saw the person since, that is not working right now, and whose
 * person is at night (REFLECT_HOURS in the account's zone), so it never
 * competes with their day. The time is
 * stamped first, so a failure does not retry in a loop.
 */
export async function reflectDueAgents(db: Db, limit = 2): Promise<number> {
  const cutoff = new Date(Date.now() - REFLECT_EVERY_MS);
  const candidates = await db
    .select({ id: agents.id, accountId: agents.accountId, reflectedAt: agents.reflectedAt, createdAt: agents.createdAt, timezone: accounts.timezone })
    .from(agents)
    .innerJoin(accounts, eq(accounts.id, agents.accountId))
    .where(
      and(
        eq(agents.hidden, false),
        or(isNull(agents.reflectedAt), lt(agents.reflectedAt, cutoff)),
        sql`exists (select 1 from messages m join conversations c on c.id = m.conversation_id
                    where c.owner_agent_id = ${agents.id} and m.agent_id is null
                      and m.created_at > coalesce(${agents.reflectedAt}, ${agents.createdAt}))`,
        sql`not exists (select 1 from runs r join conversations c on c.id = r.conversation_id where c.owner_agent_id = ${agents.id} and r.status = 'running')`,
        sql`not exists (select 1 from delegations d where d.parent_agent_id = ${agents.id} and d.status = 'running')`,
      ),
    )
    .orderBy(asc(agents.reflectedAt))
    .limit(limit * 20);
  const due = candidates
    .filter((row) => {
      const hour = localHour(row.timezone);
      return hour >= REFLECT_HOURS.from && hour < REFLECT_HOURS.to;
    })
    .slice(0, limit);
  let done = 0;
  for (const row of due) {
    const since = row.reflectedAt ?? row.createdAt;
    await db.update(agents).set({ reflectedAt: new Date() }).where(eq(agents.id, row.id));
    try {
      await reflectAgent(db, row.accountId, row.id, { since });
      done += 1;
    } catch {
      // Tried again tomorrow.
    }
  }
  return done;
}
