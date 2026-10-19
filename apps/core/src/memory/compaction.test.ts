import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, memories, messages, summaryItems } from "../db/schema.js";
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

  it("removes open items the fold settled, and keeps an agent's working facts to itself", async () => {
    const room = await openRoom("fold-open");
    for (let i = 0; i < 4; i++) await saveMessage(room, `a${i}`);
    const opener: FoldSummarizer = async (slice) => ({
      items: [{ key: "open", body: "Waiting for the logins.", messageId: slice.at(-1)!.id }],
      facts: [
        { kind: "project", subject: "Run the Numbers", body: "Renders every night at 2:30.", messageId: slice[0]!.id },
        { kind: "preference", subject: null, body: "Wants short replies.", messageId: slice[0]!.id },
        { kind: "preference", subject: "Run the Numbers", body: "Style: glass cards with lens flares.", messageId: slice[0]!.id },
        { kind: "person", subject: "Quanhui Lu", body: "Quanhui Lu is a warm sales lead.", messageId: slice[0]!.id },
        { kind: "fact", subject: null, body: "The render box has 4 cores.", messageId: slice[0]!.id },
      ],
    });
    await foldAged(db, room.accountId, room.conversationId, 1, 2, opener);
    for (let i = 0; i < 4; i++) await saveMessage(room, `b${i}`);
    let seenOpen: string[] = [];
    const closer: FoldSummarizer = async (slice, _known, open = []) => {
      seenOpen = open.map((item) => item.body);
      return { items: [{ key: "actions", body: "Logins arrived.", messageId: slice.at(-1)!.id }], closed: open.map((item) => item.id) };
    };
    await foldAged(db, room.accountId, room.conversationId, 1, 2, closer);
    expect(seenOpen).toEqual(["Waiting for the logins."]);
    const keys = (await db.select().from(summaryItems).where(eq(summaryItems.conversationId, room.conversationId))).map((item) => item.key);
    expect(keys).not.toContain("open");
    expect(keys).toContain("actions");
    const facts = await db.select().from(memories).where(eq(memories.accountId, room.accountId));
    expect(facts.find((fact) => fact.subject === "Run the Numbers")).toMatchObject({ scope: "agent", agentId: room.ownerAgentId });
    expect(facts.find((fact) => fact.body === "Wants short replies.")).toMatchObject({ scope: "user", agentId: null });
    // Only facts about the person themself are shared; a project's style, a contact or a work fact stays with the agent.
    for (const body of ["Style: glass cards with lens flares.", "Quanhui Lu is a warm sales lead.", "The render box has 4 cores."]) {
      expect(facts.find((fact) => fact.body === body)).toMatchObject({ scope: "agent", agentId: room.ownerAgentId });
    }
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
  return { accountId: account.id, conversationId: conversation!.id, ownerAgentId: owner.id };
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
