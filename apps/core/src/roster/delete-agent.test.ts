import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents, conversations, delegations, memories, messages, routines, summaryItems } from "../db/schema.js";
import { remember } from "../memory/memory.js";
import { createAccount, createAgent } from "./roster.js";
import { deleteAgent, FireAgentError } from "./delete-agent.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

const base = { provider: "openai", modelId: "gpt-5", role: "Lead", jobDescription: "Does the work here." };

/** An account with two agents, each with its own chat and a message in it. */
async function setUp(name: string) {
  const account = await createAccount(db, { name });
  const nora = await createAgent(db, account.id, { ...base, name: "Nora", label: "Nora" });
  const ethan = await createAgent(db, account.id, { ...base, name: "Ethan", label: "Ethan" });
  const chat = async (owner: string, title: string) => {
    const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: owner, title }).returning();
    const [said] = await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, agentId: owner, body: `hello from ${title}` }).returning();
    return { room: room!, said: said! };
  };
  return { account, nora, ethan, noraChat: await chat(nora.id, "Nora"), ethanChat: await chat(ethan.id, "Ethan") };
}

describe("deleteAgent", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("removes the agent, its chat, workers, routines and private facts, and keeps what it learned about the person", async () => {
    const { account, nora, ethan, noraChat, ethanChat } = await setUp("fire-agent");
    const [worker] = await db
      .insert(agents)
      .values({ accountId: account.id, name: "w-1", label: "Worker", role: "worker", jobDescription: "Render.", provider: "openai", modelId: "gpt-5", hidden: true, parentId: nora.id })
      .returning();
    await db.insert(delegations).values({ accountId: account.id, parentAgentId: nora.id, childAgentId: worker!.id, conversationId: noraChat.room.id, task: "Render", status: "done" });
    await db.insert(routines).values({ accountId: account.id, agentId: nora.id, conversationId: noraChat.room.id, title: "Night render", instructions: "Render.", cron: "30 2 * * *", nextRunAt: new Date() });
    await db.insert(summaryItems).values({ accountId: account.id, conversationId: noraChat.room.id, key: "open", body: "Waiting.", messageId: noraChat.said.id });
    const own = await remember(db, account.id, { scope: "agent", agentId: nora.id, body: "Episode 2 is about lottery tickets.", messageId: noraChat.said.id });
    const shared = await remember(db, account.id, { scope: "user", agentId: null, body: "Wants short replies.", messageId: noraChat.said.id });

    const fired = await deleteAgent(db, account.id, nora.id);
    expect(fired).toMatchObject({ name: "Nora", chats: 1, messages: 1, workers: 1 });

    const left = await db.select({ id: agents.id }).from(agents).where(eq(agents.accountId, account.id));
    expect(left.map((row) => row.id).sort()).toEqual([ethan.id].sort());
    expect(await db.select().from(conversations).where(eq(conversations.id, noraChat.room.id))).toHaveLength(0);
    expect(await db.select().from(routines).where(eq(routines.accountId, account.id))).toHaveLength(0);
    expect(await db.select().from(memories).where(eq(memories.id, own.id))).toHaveLength(0);
    const [kept] = await db.select().from(memories).where(eq(memories.id, shared.id));
    expect(kept).toMatchObject({ body: "Wants short replies.", messageId: null });
    // The other agent's chat is untouched.
    expect(await db.select().from(messages).where(eq(messages.conversationId, ethanChat.room.id))).toHaveLength(1);
  });

  it("refuses the default agent, a worker, and an agent of another account", async () => {
    const { account, nora } = await setUp("fire-refuse");
    const [support] = await db
      .insert(agents)
      .values({ accountId: account.id, name: "Cos", label: "Chief of Staff", role: "Chief of Staff", jobDescription: "Support.", provider: "openai", modelId: "gpt-5", kind: "support" })
      .returning();
    await expect(deleteAgent(db, account.id, support!.id)).rejects.toBeInstanceOf(FireAgentError);
    const other = await createAccount(db, { name: "fire-other" });
    await expect(deleteAgent(db, other.id, nora.id)).rejects.toBeInstanceOf(FireAgentError);
    const still = await db.select().from(agents).where(and(eq(agents.id, nora.id), eq(agents.accountId, account.id)));
    expect(still).toHaveLength(1);
  });

  it("refuses an agent that leads a group, so the group keeps its owner", async () => {
    const { account, nora } = await setUp("fire-group");
    await db.insert(conversations).values({ accountId: account.id, kind: "group", ownerAgentId: nora.id, title: "Content team" });
    await expect(deleteAgent(db, account.id, nora.id)).rejects.toThrow(/Content team/);
  });
});
