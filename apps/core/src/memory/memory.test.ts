import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { correct, memoriesFor, readHistory, remember } from "./memory.js";
import { createAccount, createAgent } from "../roster/roster.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

describe("memory", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("returns one cited message, and a search page instead of the whole room", async () => {
    const room = await openRoom("History");
    const cited = await saveMessage(room, "The invoice total is 40.");
    for (let index = 0; index < 8; index += 1) {
      await saveMessage(room, `ledger note ${index}`);
    }

    const one = await readHistory(db, room.accountId, room.conversationId, { messageId: cited.id });
    expect(one.map((message) => message.id)).toEqual([cited.id]);

    const page = await readHistory(db, room.accountId, room.conversationId, { search: "ledger" });
    expect(page.length).toBeGreaterThan(0);
    expect(page.length).toBeLessThanOrEqual(5);
    expect(page.every((message) => message.body.includes("ledger"))).toBe(true);
  });

  it("keeps a user fact visible to the other agent and replaces an exact fact", async () => {
    const room = await openRoom("Facts");
    const source = await saveMessage(room, "Call the client Ada.");
    const correction = await saveMessage(room, "Call the client Bea.");
    await remember(db, room.accountId, {
      scope: "user",
      agentId: null,
      body: "The client is Ada.",
      messageId: source.id,
    });
    await remember(db, room.accountId, {
      scope: "agent",
      agentId: room.agentId,
      body: "I draft the letters.",
      messageId: source.id,
    });
    await remember(db, room.accountId, {
      scope: "agent",
      agentId: room.agentId,
      body: "I draft the letters.",
      messageId: source.id,
    });

    const other = await createAgent(db, room.accountId, agent("Bea"));
    const shared = await memoriesFor(db, room.accountId, other.id);
    expect(shared.map((fact) => fact.body)).toEqual(["The client is Ada."]);

    const outsider = await createAccount(db, { name: "Outsider" });
    const hidden = await createAgent(db, outsider.id, agent("Cy"));
    expect(await memoriesFor(db, outsider.id, hidden.id)).toEqual([]);

    await correct(db, room.accountId, {
      scope: "user",
      agentId: null,
      oldBody: "The client is Ada.",
      body: "The client is Bea.",
      messageId: correction.id,
    });
    const updated = await memoriesFor(db, room.accountId, other.id);
    expect(updated.map((fact) => fact.body)).toEqual(["The client is Bea."]);
    expect(updated.map((fact) => fact.messageId)).toEqual([correction.id]);
    const firstAgent = await memoriesFor(db, room.accountId, room.agentId);
    expect(firstAgent.map((fact) => fact.body).sort()).toEqual(["I draft the letters.", "The client is Bea."]);
  });
});

async function openRoom(name: string) {
  const account = await createAccount(db, { name });
  const owner = await createAgent(db, account.id, agent("Ada"));
  const [conversation] = await db
    .insert(conversations)
    .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: name })
    .returning();
  return { accountId: account.id, agentId: owner.id, conversationId: conversation!.id };
}

async function saveMessage(room: { accountId: string; conversationId: string }, body: string) {
  const [message] = await db
    .insert(messages)
    .values({ accountId: room.accountId, conversationId: room.conversationId, agentId: null, body })
    .returning();
  return message!;
}

function agent(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
