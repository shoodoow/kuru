import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { foldOldest, mergeSummary } from "./summary.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

describe("summary", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("stores one cited item per summary key", async () => {
    const room = await openRoom("Merge");
    const message = await saveMessage(room, "We ship on Friday.");
    const saved = await mergeSummary(db, room.accountId, room.conversationId, [
      { key: "decisions", body: "Ship on Friday.", messageId: message.id },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ key: "decisions", body: "Ship on Friday.", messageId: message.id });
  });

  it("folds the oldest slice into the summary and keeps those messages", async () => {
    const room = await openRoom("Fold");
    const bodies = ["one", "two", "three", "four"];
    const stored = [];
    for (const body of bodies) {
      stored.push(await saveMessage(room, body));
    }
    const folded = await foldOldest(db, room.accountId, room.conversationId, 2, async (slice) => [
      { key: "topics", body: slice.map((message) => message.body).join(", "), messageId: slice[0]!.id },
    ]);
    expect(folded.map((item) => item.body)).toEqual(["one, two"]);
    const remaining = await db.select().from(messages).where(eq(messages.conversationId, room.conversationId));
    expect(remaining.map((message) => message.id).sort()).toEqual(stored.map((message) => message.id).sort());
  });
});

async function openRoom(name: string) {
  const account = await createAccount(db, { name });
  const owner = await createAgent(db, account.id, {
    name: "Ada",
    label: "Ada",
    role: "Teammate",
    jobDescription: "Ada works here.",
    provider: "openai",
    modelId: "gpt-5",
  });
  const [conversation] = await db
    .insert(conversations)
    .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: name })
    .returning();
  return { accountId: account.id, conversationId: conversation!.id };
}

async function saveMessage(room: { accountId: string; conversationId: string }, body: string) {
  const [message] = await db
    .insert(messages)
    .values({ accountId: room.accountId, conversationId: room.conversationId, agentId: null, body })
    .returning();
  return message!;
}
