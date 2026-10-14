import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../db/client.js";
import { conversations, delegations, members, runs } from "../../db/schema.js";
import { createAccount, createAgent } from "../../roster/roster.js";
import { accountUsage, usagePeriod } from "./account-usage.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** Locks the account usage page's numbers: what counts, whose it is, and which days it covers. */
describe("account usage", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("adds turns and background jobs by day, by agent and by model, inside the period only", async () => {
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
      { accountId: account.id, conversationId: ada.room.id, status: "done", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, provider: "openai", modelId: "gpt-5" },
      { accountId: account.id, conversationId: ada.room.id, status: "done", inputTokens: 500, outputTokens: 50, createdAt: daysAgo(2) },
      { accountId: account.id, conversationId: bea.room.id, status: "done", inputTokens: 200, outputTokens: 20, createdAt: daysAgo(3) },
      // Outside a week, inside a month. A run with no usage recorded still counts as a turn.
      { accountId: account.id, conversationId: bea.room.id, status: "done", createdAt: daysAgo(20) },
    ]);
    await db.insert(delegations).values([
      // A job from before the model was recorded is not guessed: it counts as unknown.
      { accountId: account.id, conversationId: ada.room.id, parentAgentId: ada.agent.id, childAgentId: ada.agent.id, task: "build", status: "done", inputTokens: 9000, outputTokens: 900 },
      // A job on the background model counts against that model.
      { accountId: account.id, conversationId: ada.room.id, parentAgentId: ada.agent.id, childAgentId: ada.agent.id, task: "render", status: "done", inputTokens: 3000, outputTokens: 300, provider: "anthropic", modelId: "claude-haiku-5-5" },
    ]);

    const week = await accountUsage(db, account.id, "week");
    expect(week.bucket).toBe("day");
    expect(week.totals).toEqual({ inputTokens: 13_700, outputTokens: 1370, cacheReadTokens: 400, turns: 3, jobs: 2 });
    expect(week.series).toHaveLength(7);
    expect(week.series.at(-1)).toMatchObject({ inputTokens: 13_000, turns: 1, jobs: 2, models: { "openai/gpt-5": 1100, unknown: 9900, "anthropic/claude-haiku-5-5": 3300 } });
    expect(week.agents.map((row) => [row.name, row.inputTokens, row.turns, row.jobs])).toEqual([
      ["Ada", 13_500, 2, 2],
      ["Bea", 200, 1, 0],
    ]);
    // Turns from before models were recorded are unknown too, never the agent's current model.
    expect(week.models.map((row) => [row.key, row.inputTokens + row.outputTokens, row.jobs])).toEqual([
      ["unknown", 10_670, 1],
      ["anthropic/claude-haiku-5-5", 3300, 1],
      ["openai/gpt-5", 1100, 0],
    ]);

    const today = await accountUsage(db, account.id, "today");
    expect(today.bucket).toBe("hour");
    expect(today.series.length).toBe(new Date().getUTCHours() + 1);
    expect(today.totals.turns).toBe(1);

    const month = await accountUsage(db, account.id, "month");
    expect(month.series).toHaveLength(new Date().getUTCDate());
    expect(month.totals.turns).toBe(1 + [2, 3, 20].filter((days) => daysAgo(days).getUTCMonth() === new Date().getUTCMonth()).length);
    // An old client asking for days gets the nearest period.
    expect([usagePeriod(undefined, 7), usagePeriod(undefined, 30), usagePeriod("today")]).toEqual(["week", "month", "today"]);
  });

  it("returns zeros for an account that has done nothing", async () => {
    const account = await createAccount(db, { name: "Quiet" });
    const usage = await accountUsage(db, account.id, "week");
    expect(usage.totals).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, jobs: 0 });
    expect(usage.agents).toEqual([]);
    expect(usage.series).toHaveLength(7);
    expect(usage.models).toEqual([]);
  });
});
