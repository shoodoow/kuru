import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, delegations, memories } from "../db/schema.js";
import { runningWork } from "../rooms/running-work.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { agentMemoryPage, forgetAllMemories, forgetMemory } from "./agent-memory-page.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

async function twoAgents(name: string) {
  const account = await createAccount(db, { name });
  const make = (agentName: string) =>
    createAgent(db, account.id, { name: agentName, label: agentName, role: "Teammate", jobDescription: `${agentName} works here.`, provider: "openai", modelId: "gpt-5" });
  return { accountId: account.id, nora: await make("Nora"), max: await make("Max") };
}

describe("agent memory page", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("shows an agent its own facts and the shared ones, never another agent's", async () => {
    const { accountId, nora, max } = await twoAgents("memory-page");
    await db.insert(memories).values([
      { accountId, scope: "agent", agentId: nora.id, body: "Renders at 2:30." },
      { accountId, scope: "agent", agentId: max.id, body: "Posts on Hacker News." },
      { accountId, scope: "user", agentId: null, body: "Wants short replies." },
    ]);
    const page = await agentMemoryPage(db, accountId, nora.id);
    expect(page?.map((fact) => [fact.scope, fact.body])).toEqual([
      ["agent", "Renders at 2:30."],
      ["shared", "Wants short replies."],
    ]);
  });

  it("removes a fact for good, with the older versions it replaced", async () => {
    const { accountId, nora, max } = await twoAgents("memory-forget");
    const [newest] = await db.insert(memories).values({ accountId, scope: "agent", agentId: nora.id, body: "Style v2." }).returning();
    await db.insert(memories).values({ accountId, scope: "agent", agentId: nora.id, body: "Style v1.", supersededBy: newest!.id });
    // Another agent cannot remove it from its own page.
    expect(await forgetMemory(db, accountId, max.id, newest!.id)).toBeNull();
    expect(await forgetMemory(db, accountId, nora.id, newest!.id)).toEqual({ removed: 2 });
    expect(await db.select().from(memories).where(eq(memories.agentId, nora.id))).toHaveLength(0);
  });

  it("clears everything an agent keeps for itself, leaving shared facts and other agents alone", async () => {
    const { accountId, nora, max } = await twoAgents("memory-clear");
    const [newest] = await db.insert(memories).values({ accountId, scope: "agent", agentId: nora.id, body: "Rule v2." }).returning();
    await db.insert(memories).values([
      { accountId, scope: "agent", agentId: nora.id, body: "Rule v1.", supersededBy: newest!.id },
      { accountId, scope: "agent", agentId: max.id, body: "Max's rule." },
      { accountId, scope: "user", agentId: null, body: "Wants short replies." },
    ]);
    expect(await forgetAllMemories(db, accountId, nora.id)).toEqual({ removed: 2 });
    expect((await agentMemoryPage(db, accountId, nora.id))?.map((fact) => fact.body)).toEqual(["Wants short replies."]);
    expect((await agentMemoryPage(db, accountId, max.id))?.map((fact) => fact.body)).toEqual(["Max's rule.", "Wants short replies."]);
  });

  it("lists an agent's running and recently ended jobs", async () => {
    const { accountId, nora, max: worker } = await twoAgents("running-work");
    const [chat] = await db.insert(conversations).values({ accountId, kind: "direct", ownerAgentId: nora.id, title: "Nora" }).returning();
    await db.insert(delegations).values([
      { accountId, conversationId: chat!.id, parentAgentId: nora.id, childAgentId: worker.id, task: "Scheduled job: Overnight render. This run was started by its schedule.", status: "running" },
      { accountId, conversationId: chat!.id, parentAgentId: nora.id, childAgentId: worker.id, task: "Make the cover brighter.", status: "done", result: "Done." },
    ]);
    const work = await runningWork(db, accountId, nora.id);
    expect(work?.running).toMatchObject([{ title: "Overnight render", source: "routine", status: "lost" }]);
    expect(work?.recent).toMatchObject([{ title: "Make the cover brighter.", source: "job", status: "done" }]);
    expect(work?.replying).toBe(false);
  });
});
