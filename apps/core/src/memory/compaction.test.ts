import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, messages, summaryItems } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { foldAged } from "./compaction.js";
import type { FoldSummarizer } from "./compaction.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** Summarizer that cites the newest message in the slice, so the watermark advances. */
const stubSummarize: FoldSummarizer = async (slice) => [
  { key: "topics", body: `folded ${slice.length}: ${slice.map((m) => m.body).join(",")}`, messageId: slice.at(-1)!.id },
];

describe("foldAged", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("does nothing until enough messages have aged out of the window", async () => {
    const room = await openRoom("fold-window");
    for (let i = 0; i < 5; i++) await saveMessage(room, `m${i}`);
    // keepRecent 4, minBatch 2 → only 1 aged out, below batch.
    const folded = await foldAged(db, room.accountId, room.conversationId, 4, 2, stubSummarize);
    expect(folded).toEqual([]);
  });

  it("folds each aged-out message exactly once across turns (watermark)", async () => {
    const room = await openRoom("fold-watermark");
    for (let i = 0; i < 10; i++) await saveMessage(room, `m${i}`);
    // keepRecent 4 → 6 aged out; minBatch 2.
    const first = await foldAged(db, room.accountId, room.conversationId, 4, 2, stubSummarize);
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toContain("folded 6");

    // No new messages → nothing new to fold.
    const again = await foldAged(db, room.accountId, room.conversationId, 4, 2, stubSummarize);
    expect(again).toEqual([]);

    // Two more messages → only the newly aged-out ones fold, never the old six.
    await saveMessage(room, "m10");
    await saveMessage(room, "m11");
    const third = await foldAged(db, room.accountId, room.conversationId, 4, 2, stubSummarize);
    expect(third).toHaveLength(1);
    expect(third[0]!.body).toContain("folded 2");
    expect(third[0]!.body).toContain("m6");
    expect(third[0]!.body).toContain("m7");

    const items = await db
      .select()
      .from(summaryItems)
      .where(eq(summaryItems.conversationId, room.conversationId))
      .orderBy(asc(summaryItems.createdAt));
    expect(items).toHaveLength(2);
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
  // Space out createdAt so ordering is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 2));
  return message!;
}
