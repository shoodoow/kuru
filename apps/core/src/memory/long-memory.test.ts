/**
 * Long-history check: two simulated years of chat in one room.
 * Planted facts and a correction must still be reachable long after they left
 * the recent window, with no embedding key (full text + entity lookup only),
 * and the memory part of the prompt must not grow with the history.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, members, memories, messages, summaryItems } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { foldAged, type FoldSummarizer } from "./compaction.js";
import { buildContext } from "./context.js";
import { factsAboutMentioned, memoriesFor, profileFor } from "./memory.js";
import { recallHits } from "./recall.js";
import { refreshProfile, rollUp } from "./rollup.js";
import { hitLine, searchMessages, searchTerms } from "./search.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

const KEEP_RECENT = 24;

/**
 * Stand-in for the model: summarizes each slice in one line and lifts lines
 * written as "FACT kind | subject: text" or "CHANGE subject: text" into facts.
 */
const stubSummarize: FoldSummarizer = async (slice, known) => {
  const facts = [];
  for (const message of slice) {
    const fact = message.body.match(/^FACT (\w+) \| ([^:]*): (.+)$/);
    if (fact) facts.push({ kind: fact[1] as "person", subject: fact[2]!.trim() || null, body: fact[3]!, messageId: message.id });
    const change = message.body.match(/^CHANGE ([^:]+): (.+)$/);
    if (change) {
      const old = known.find((item) => item.subject === change[1]);
      facts.push({ kind: "fact" as const, subject: change[1]!, body: change[2]!, messageId: message.id, replaces: old?.id });
    }
  }
  return {
    items: [
      { key: "topics", body: `Talked about ${slice.length} things, starting with ${slice[0]!.body.slice(0, 40)}`, messageId: slice.at(-1)!.id },
      { key: "actions", body: `Handled the errands up to note ${slice.at(-1)!.body.slice(0, 30)}`, messageId: slice.at(-1)!.id },
      { key: "open", body: `Nothing pending after ${slice.length} notes`, messageId: slice[0]!.id },
    ],
    facts,
  };
};

describe("memory over a two-year history", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("recalls planted facts, applies corrections, and keeps the prompt the same size", async () => {
    const account = await createAccount(db, { name: "LongMemory" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Chief of staff",
      jobDescription: "Runs operations.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "long" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const start = Date.UTC(2024, 0, 1);
    const total = 1200;
    const stepMs = (2 * 365 * 24 * 60 * 60 * 1000) / total;
    const planted: Record<number, string> = {
      20: "FACT person | Sara Ahmadi: Head of marketing at Acme; approves all ad spend.",
      40: "FACT org | Acme: Retail client since 2024, billed monthly.",
      60: "FACT fact | Acme budget: Ad budget is 8,000 USD per month.",
      300: "FACT preference | : Wants weekly reports on Monday morning as a short table.",
      700: "CHANGE Acme budget: Ad budget is 12,000 USD per month.",
      900: "FACT project | Zephyr launch: Product launch planned for March 2026 in Istanbul.",
    };
    const sizes: number[] = [];
    const insertBatch = async (from: number, to: number) => {
      await db.insert(messages).values(
        Array.from({ length: to - from }, (_, offset) => {
          const index = from + offset;
          return {
            accountId: account.id,
            conversationId: room!.id,
            agentId: index % 2 === 1 ? agent.id : null,
            body: planted[index] ?? `Routine note number ${index} about the weekly schedule and small errands.`,
            createdAt: new Date(start + index * stepMs),
          };
        }),
      );
    };
    const measure = async () => {
      const summary = await db.select().from(summaryItems).where(eq(summaryItems.conversationId, room!.id));
      const facts = await memoriesFor(db, account.id, agent.id);
      const context = buildContext({
        accountId: account.id,
        agentId: agent.id,
        promptVersion: 1,
        identity: { name: "Ada", role: "Chief of staff", personality: "", job: "Runs operations." },
        summary: summary.map((item) => ({ key: item.key, body: item.body, messageId: item.messageId, level: item.level })),
        messages: [],
        memories: facts.map((fact) => ({ body: fact.body, subject: fact.subject })),
        profile: await profileFor(db, account.id),
      });
      return context.tail.length;
    };

    // Messages arrive in chunks; after each chunk the backlog is folded, as it would be turn by turn.
    for (let from = 0; from < total; from += 100) {
      await insertBatch(from, from + 100);
      for (;;) {
        const folded = await foldAged(db, account.id, room!.id, KEEP_RECENT, 20, stubSummarize);
        if (folded.length === 0 && !folded.factsSaved) break;
      }
      // Month digests are written as periods finish, seen from "now" = the chunk's last message.
      const now = new Date(start + (from + 100) * stepMs);
      while (await rollUp(db, account.id, room!.id, async () => "", 1, now)) {
        // keep condensing until no finished month is left
      }
      if (from === 500 || from === 1100) sizes.push(await measure());
    }
    await rollUp(db, account.id, room!.id, async () => "", 2, new Date(start + total * stepMs));

    // Every aged-out message was folded exactly once.
    const [watermark] = await db.select({ at: conversations.foldedThrough }).from(conversations).where(eq(conversations.id, room!.id));
    expect(watermark?.at).not.toBeNull();

    // The correction replaced the old budget; the old row is kept but not current.
    const all = await db.select().from(memories).where(eq(memories.accountId, account.id));
    const budget = all.filter((fact) => fact.subject === "Acme budget");
    expect(budget).toHaveLength(2);
    expect(budget.filter((fact) => fact.supersededBy === null).map((fact) => fact.body)).toEqual([
      "Ad budget is 12,000 USD per month.",
    ]);

    // Naming a subject pulls its current facts, with no embeddings involved.
    const aboutAcme = await factsAboutMentioned(db, account.id, agent.id, "what is the acme budget and who approves it?");
    expect(aboutAcme.map((fact) => fact.body)).toContain("Ad budget is 12,000 USD per month.");
    expect(aboutAcme.map((fact) => fact.body)).not.toContain("Ad budget is 8,000 USD per month.");
    expect(aboutAcme.map((fact) => fact.subject)).toContain("Acme");

    // Full-text recall finds an early fact from a question asked two years later.
    const recalled = await recallHits(db, {
      accountId: account.id,
      agentId: agent.id,
      conversationId: room!.id,
      query: "Who approves ad spend in marketing?",
    });
    expect(recalled.map((hit) => hitLine(hit)).join("\n")).toContain("Sara Ahmadi");

    // The raw message is still there to be searched and dated.
    const old = await searchMessages(db, {
      accountId: account.id,
      agentId: agent.id,
      terms: searchTerms("Zephyr launch Istanbul"),
      limit: 3,
    });
    expect(old[0]?.body).toContain("Zephyr launch");
    expect(old[0]?.at.toISOString().slice(0, 4)).toBe("2025");

    // Months were condensed, and a finished year too.
    const digests = await db.select().from(summaryItems).where(eq(summaryItems.conversationId, room!.id));
    expect(digests.filter((item) => item.level === 1).length).toBeGreaterThan(10);
    expect(digests.filter((item) => item.level === 2).length).toBeGreaterThanOrEqual(1);

    // The profile is written from current facts only.
    await refreshProfile(db, account.id, async (_system, user) => `Profile built from ${user.length} chars. Budget 12,000.`, all[0]!.messageId);
    expect(await profileFor(db, account.id)).toContain("12,000");

    // History doubled between the two measurements; the memory part of the prompt did not grow.
    const [early, late] = sizes as [number, number];
    expect(late).toBeLessThan(early * 1.1);
    expect(late).toBeLessThan(14_000);
  }, 120_000);
});
