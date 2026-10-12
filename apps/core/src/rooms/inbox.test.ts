import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations, delegations, members, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { inboxStatus, markRead } from "./inbox.js";
import { acquireRun, finishRun } from "./runs.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** Locks what the inbox list shows beside a chat: unread agent messages and running work. */
describe("inbox status", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  async function room() {
    const account = await createAccount(db, { name: "Inbox" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Answers messages.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [row] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "inbox" })
      .returning();
    await db.insert(members).values({ conversationId: row!.id, accountId: account.id, agentId: agent.id });
    return { accountId: account.id, agentId: agent.id, roomId: row!.id };
  }

  it("counts agent messages since the chat was last read, and never the person's own", async () => {
    const { accountId, agentId, roomId } = await room();
    await db.insert(messages).values([
      { accountId, conversationId: roomId, agentId: null, body: "hi" },
      { accountId, conversationId: roomId, agentId, body: "hello" },
      { accountId, conversationId: roomId, agentId, body: "how can I help?" },
    ]);
    expect((await inboxStatus(db, accountId)).rooms).toMatchObject([{ id: roomId, unread: 2, working: false }]);

    expect(await markRead(db, accountId, roomId)).toBe(true);
    expect((await inboxStatus(db, accountId)).rooms[0]?.unread).toBe(0);

    await db.insert(messages).values({ accountId, conversationId: roomId, agentId, body: "done" });
    expect((await inboxStatus(db, accountId)).rooms[0]?.unread).toBe(1);
  });

  it("refuses to mark a chat on another account", async () => {
    const mine = await room();
    const other = await room();
    expect(await markRead(db, mine.accountId, other.roomId)).toBe(false);
  });

  it("reports an agent as working during a turn and while background work runs", async () => {
    const { accountId, agentId, roomId } = await room();
    const run = await acquireRun(db, accountId, roomId);
    expect(await inboxStatus(db, accountId)).toMatchObject({ rooms: [{ working: true }], workingAgentIds: [agentId] });
    await finishRun(db, run.id);
    expect((await inboxStatus(db, accountId)).workingAgentIds).toEqual([]);

    await db
      .insert(delegations)
      .values({ accountId, conversationId: roomId, parentAgentId: agentId, childAgentId: agentId, task: "build it" });
    expect(await inboxStatus(db, accountId)).toMatchObject({ rooms: [{ working: true }], workingAgentIds: [agentId] });
  });
});
