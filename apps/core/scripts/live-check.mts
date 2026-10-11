/**
 * Sends real messages to one agent in a fresh room and prints what the person would see.
 * Why: prompt and loop changes are only proven by a real model run.
 * Usage: npx tsx --env-file .env scripts/live-check.mts <agentId> "<message>" ["<message>" ...]
 * The room is kept; pass its id to scripts/trace-report.mts to see steps and tokens.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { agents, conversations, delegations, members, messages, runs } from "../src/db/schema.js";
import { runTurn } from "../src/turn/orchestrator.js";
import { resolveSkillsDir } from "../src/skills/paths.js";

const args = process.argv.slice(2);
// --new: talk to a throwaway copy of the agent, so team tests leave the real chat alone.
const fresh = args[0] === "--new";
const [agentId, ...texts] = fresh ? args.slice(1) : args;
if (!agentId || texts.length === 0) throw new Error("Usage: live-check.mts <agentId> <message...>");
const db = getDb(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database");
const [source] = await db.select().from(agents).where(eq(agents.id, agentId));
if (!source) throw new Error("Agent not found.");
let agent = source;
if (fresh) {
  const [copy] = await db
    .insert(agents)
    .values({
      accountId: source.accountId,
      name: `LiveLead-${process.env.LIVE_LABEL ?? "Lead"}-${Math.random().toString(36).slice(2, 6)}`,
      label: process.env.LIVE_LABEL ?? "Live Lead",
      role: source.role,
      personality: source.personality,
      jobDescription: source.jobDescription,
      provider: source.provider,
      modelId: source.modelId,
    })
    .returning();
  agent = copy!;
  console.log(`agent ${agent.id}`);
}
const skillsRoot = process.env.SKILLS_DIR ?? resolveSkillsDir();
const [room] = await db
  .insert(conversations)
  .values({ accountId: agent.accountId, kind: "direct", ownerAgentId: agent.id, title: `live-check ${agent.label}` })
  .returning();
await db.insert(members).values({ accountId: agent.accountId, conversationId: room!.id, agentId: agent.id });
console.log(`room ${room!.id}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = new Set<string>();
const labels = new Map<string, string>();
/** Every room the agent is in: its private chat plus any team chat it created. */
async function roomIds(): Promise<string[]> {
  const rows = await db.select({ id: members.conversationId }).from(members).where(eq(members.agentId, agent.id));
  return [...new Set([room!.id, ...rows.map((row) => row.id)])];
}
async function printNew(): Promise<void> {
  const ids = await roomIds();
  for (const row of await db.select({ id: agents.id, label: agents.label }).from(agents).where(eq(agents.accountId, agent.accountId))) {
    labels.set(row.id, row.label);
  }
  const rows = await db.select().from(messages).where(inArray(messages.conversationId, ids)).orderBy(messages.createdAt);
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const kinds = Array.isArray(row.payload) ? (row.payload as { kind: string }[]).map((block) => block.kind).join(",") : "";
    const where = row.conversationId === room!.id ? "PRIVATE" : "TEAM";
    const relay = row.relayKind ? ` badge:${row.relayKind}` : "";
    console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${where}${relay} ${row.agentId ? (labels.get(row.agentId) ?? "agent") : "PERSON"} (${kinds}): ${row.body.slice(0, 900)}`);
  }
}
/** Waits until no turn and no worker is running in the room, up to a limit. */
async function settle(limitMs: number): Promise<void> {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < limitMs) {
    await sleep(3000);
    await printNew();
    const ids = await roomIds();
    const busyRuns = await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.conversationId, ids), eq(runs.status, "running")));
    const busyWorkers = await db
      .select({ id: delegations.id })
      .from(delegations)
      .where(and(inArray(delegations.conversationId, ids), inArray(delegations.status, ["running"])));
    quiet = busyRuns.length + busyWorkers.length === 0 ? quiet + 1 : 0;
    if (quiet >= 6) return;
  }
  console.log("\n(timed out waiting for the room to go quiet)");
}
const limit = Number(process.env.LIVE_LIMIT_MS ?? 600_000);
for (const text of texts) {
  await runTurn(db, agent.accountId, room!.id, text, undefined, skillsRoot);
  await settle(limit);
}
await printNew();
await db.$client.end();
process.exit(0);
