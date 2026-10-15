/**
 * An agent's nightly reflection ("sleep").
 * Why: an agent got no better between days. What the person corrected, what
 * worked and what failed in background jobs stayed in old chat lines, while
 * its memory gathered duplicates and outdated facts. Once a day, while nobody
 * waits, a cheap model reads what happened since the last time and makes a
 * few small edits: new rules, better wordings, retired facts. Small edits, not
 * a rewrite, so what it knows sharpens without wearing away over months.
 * The rules reach every worker the agent starts (see worker-lessons).
 */
import { generateText } from "ai";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, delegations, memories, messages } from "../db/schema.js";
import { getModel } from "../model/get-model.js";
import { prompt } from "../prompt/prompts.js";
import { backgroundModelFor } from "../rooms/subagents.js";
import { remember, supersede } from "./memory.js";

type Db = ReturnType<typeof getDb>;

/** How often an agent reflects, at most. */
export const REFLECT_EVERY_MS = 20 * 60 * 60 * 1000;
/** How much of the day it reads, so a busy day stays one cheap call. */
const CONVERSATION_CHARS = 24_000;
const JOB_CHARS = 8_000;
const MAX_EDITS = 8;

export type ReflectionEdit =
  | { op: "rule" | "fact"; body: string }
  | { op: "replace"; target: string; body: string }
  | { op: "retire"; target: string };

/** Reads the model's lines into edits; anything not in the format is ignored. */
export function parseReflection(text: string): ReflectionEdit[] {
  const edits: ReflectionEdit[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-*\s]+/, "").trim();
    if (!line || /^nothing\.?$/i.test(line)) continue;
    let match: RegExpExecArray | null;
    if ((match = /^(rule|fact):\s*(.{3,400})$/i.exec(line))) edits.push({ op: match[1]!.toLowerCase() as "rule" | "fact", body: match[2]!.trim() });
    else if ((match = /^replace\s+([RF]\d{1,3}):\s*(.{3,400})$/i.exec(line))) edits.push({ op: "replace", target: match[1]!.toUpperCase(), body: match[2]!.trim() });
    else if ((match = /^retire\s+([RF]\d{1,3})\b/i.exec(line))) edits.push({ op: "retire", target: match[1]!.toUpperCase() });
    if (edits.length >= MAX_EDITS) break;
  }
  return edits;
}

type Fact = { id: string; body: string; kind: string };

/** What one reflection read and wrote (or would write, in a dry run), with the rules and facts it started from. */
export type ReflectionResult = {
  read: { messages: number; jobs: number };
  edits: ReflectionEdit[];
  applied: number;
  before?: { rules: string[]; facts: string[] };
};

/**
 * Reflects for one agent on what happened since `since`.
 * Input: db, account and agent ids, the start of the window, and an optional
 * model stand-in (tests). Output: what it read and applied; nothing is written
 * when there was no new conversation.
 */
export async function reflectAgent(
  db: Db,
  accountId: string,
  agentId: string,
  since: Date,
  think?: (system: string, user: string) => Promise<string>,
  /** Work out the edits and return them without writing anything, so a person can review them. */
  dryRun = false,
): Promise<ReflectionResult> {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) return { read: { messages: 0, jobs: 0 }, edits: [], applied: 0 };
  const rooms = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.ownerAgentId, agentId)));
  const roomIds = rooms.map((room) => room.id);
  const said = roomIds.length
    ? await db
        .select({ id: messages.id, agentId: messages.agentId, body: messages.body, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.accountId, accountId), inArray(messages.conversationId, roomIds), gt(messages.createdAt, since)))
        .orderBy(asc(messages.createdAt))
        .limit(400)
    : [];
  const fromPerson = said.filter((row) => !row.agentId);
  // Nothing the person said: nothing to learn from, and no source to cite.
  if (fromPerson.length === 0) return { read: { messages: said.length, jobs: 0 }, edits: [], applied: 0 };
  const jobs = await db
    .select({ status: delegations.status, task: delegations.task, result: delegations.result, createdAt: delegations.createdAt })
    .from(delegations)
    .where(and(eq(delegations.accountId, accountId), eq(delegations.parentAgentId, agentId), gt(delegations.createdAt, since)))
    .orderBy(asc(delegations.createdAt))
    .limit(40);
  const own = await db
    .select({ id: memories.id, body: memories.body, kind: memories.kind })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.scope, "agent"), eq(memories.agentId, agentId), isNull(memories.supersededBy)))
    .orderBy(desc(memories.createdAt))
    .limit(80);
  const rules: Fact[] = own.filter((fact) => fact.kind === "procedure");
  const facts: Fact[] = own.filter((fact) => fact.kind !== "procedure" && fact.kind !== "profile").slice(0, 40);

  const conversation = fitFromEnd(
    said.map((row) => `${row.agentId ? agent.name : "Person"}: ${row.body.replace(/\s+/g, " ").trim().slice(0, row.agentId ? 600 : 3_000)}`),
    CONVERSATION_CHARS,
  );
  const jobLines = fitFromEnd(
    jobs.map((job) => `- [${job.status}] ${job.task.replace(/\s+/g, " ").slice(0, 200)} → ${(job.result ?? "no report").replace(/\s+/g, " ").slice(0, 600)}`),
    JOB_CHARS,
  );
  const user = prompt("memory", "reflect-user", {
    name: agent.name,
    role: agent.role,
    rules: rules.length ? rules.map((rule, index) => `R${index + 1}: ${rule.body}`).join("\n") : "(none)",
    facts: facts.length ? facts.map((fact, index) => `F${index + 1}: ${fact.body}`).join("\n") : "(none)",
    conversation: conversation || "(none)",
    jobs: jobLines || "(none)",
  });
  const text = think ? await think(prompt("memory", "reflect"), user) : await callModel(db, accountId, agent, user);
  const edits = parseReflection(text);
  const before = { rules: rules.map((rule) => rule.body), facts: facts.map((fact) => fact.body) };
  if (dryRun) return { read: { messages: said.length, jobs: jobs.length }, edits, applied: 0, before };
  const source = fromPerson.at(-1)!.id;
  let applied = 0;
  const pick = (target: string): Fact | undefined => {
    const list = target.startsWith("R") ? rules : facts;
    return list[Number(target.slice(1)) - 1];
  };
  for (const edit of edits) {
    try {
      if (edit.op === "rule" || edit.op === "fact") {
        await remember(db, accountId, { scope: "agent", agentId, kind: edit.op === "rule" ? "procedure" : "fact", body: edit.body, messageId: source });
        applied += 1;
      } else if (edit.op === "replace") {
        const old = pick(edit.target);
        if (!old) continue;
        const saved = await remember(db, accountId, { scope: "agent", agentId, kind: old.kind, body: edit.body, messageId: source });
        if (saved.id !== old.id) await supersede(db, accountId, old.id, saved.id);
        applied += 1;
      } else if (edit.op === "retire") {
        const old = pick(edit.target);
        if (!old) continue;
        // Retired: replaced by nothing, so it leaves every view and stays as history.
        await supersede(db, accountId, old.id, old.id);
        applied += 1;
      }
    } catch {
      // One bad edit does not stop the others.
    }
  }
  return { read: { messages: said.length, jobs: jobs.length }, edits, applied, before };
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

async function callModel(db: Db, accountId: string, agent: typeof agents.$inferSelect, user: string): Promise<string> {
  const runOn = await backgroundModelFor(db, accountId, agent);
  const result = await generateText({
    model: getModel(runOn.provider, runOn.modelId, runOn.credential.apiKey, runOn.credential.baseUrl),
    instructions: [{ role: "system" as const, content: prompt("memory", "reflect") }],
    messages: [{ role: "user", content: user }],
  });
  return result.text ?? "";
}

/**
 * Reflects for the agents that are due, a few per call.
 * Due: a visible agent that has not reflected for REFLECT_EVERY_MS, whose
 * chats saw the person since, and that is not working right now (so the
 * reflection never competes with a live turn). The time is stamped first, so
 * a failure does not retry in a loop.
 * Output: how many agents reflected.
 */
export async function reflectDueAgents(db: Db, limit = 2, think?: (system: string, user: string) => Promise<string>): Promise<number> {
  const cutoff = new Date(Date.now() - REFLECT_EVERY_MS);
  const due = await db
    .select({ id: agents.id, accountId: agents.accountId, reflectedAt: agents.reflectedAt, createdAt: agents.createdAt })
    .from(agents)
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
    .limit(limit);
  let done = 0;
  for (const row of due) {
    await db.update(agents).set({ reflectedAt: new Date() }).where(eq(agents.id, row.id));
    try {
      await reflectAgent(db, row.accountId, row.id, row.reflectedAt ?? row.createdAt, think);
      done += 1;
    } catch {
      // Tried again tomorrow.
    }
  }
  return done;
}
