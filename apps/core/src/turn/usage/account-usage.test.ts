import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../db/client.js";
import { conversations, delegations, members, runs } from "../../db/schema.js";
import { createAccount, createAgent } from "../../roster/roster.js";
import { accountUsage } from "./account-usage.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** Locks the account usage page's numbers: what counts, whose it is, and which days it covers. */
describe("account usage", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("adds turns and background jobs by day and by agent, inside the period only", async () => {
    const account = await createAccount(db, { name: "Usage" });
    const make = async (name: string) => {
      const agent = await createAgent(db, account.id, { name, label: name, role: "Teammate", jobDescription: "Works.", provider: "openai", modelId: "gpt-5" });
      const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: name }).returning();
      await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });
      return { agent, room: room! };
    };
    const ada = await make("Ada");
    const bea = await make("Bea");
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.insert(runs).values([
      { accountId: account.id, conversationId: ada.room.id, status: "done", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 },
      { accountId: account.id, conversationId: ada.room.id, status: "done", inputTokens: 500, outputTokens: 50, createdAt: daysAgo(2) },
      { accountId: account.id, conversationId: bea.room.id, status: "done", inputTokens: 200, outputTokens: 20, createdAt: daysAgo(3) },
      // Outside a week, inside a month. A run with no usage recorded still counts as a turn.
      { accountId: account.id, conversationId: bea.room.id, status: "done", createdAt: daysAgo(20) },
    ]);
    await db.insert(delegations).values({
      accountId: account.id,
      conversationId: ada.room.id,
      parentAgentId: ada.agent.id,
      childAgentId: ada.agent.id,
      task: "build",
      status: "done",
      inputTokens: 9000,
      outputTokens: 900,
    });

    const week = await accountUsage(db, account.id, 7);
    expect(week.totals).toEqual({ inputTokens: 10_700, outputTokens: 1070, cacheReadTokens: 400, turns: 3, jobs: 1 });
    expect(week.daily).toHaveLength(7);
    expect(week.daily.at(-1)).toMatchObject({ inputTokens: 10_000, turns: 1, jobs: 1 });
    expect(week.agents.map((row) => [row.name, row.inputTokens, row.turns, row.jobs])).toEqual([
      ["Ada", 10_500, 2, 1],
      ["Bea", 200, 1, 0],
    ]);

    const month = await accountUsage(db, account.id, 30);
    expect(month.totals.turns).toBe(4);
    // An unknown period falls back to a month.
    expect((await accountUsage(db, account.id, 12)).days).toBe(30);
  });

  it("returns zeros for an account that has done nothing", async () => {
    const account = await createAccount(db, { name: "Quiet" });
    const usage = await accountUsage(db, account.id, 7);
    expect(usage.totals).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, jobs: 0 });
    expect(usage.agents).toEqual([]);
    expect(usage.daily).toHaveLength(7);
  });
});
