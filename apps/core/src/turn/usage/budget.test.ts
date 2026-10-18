import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { conversations, delegations, members, notifications } from "../../db/schema.js";
import { createAccount, createAgent } from "../../roster/roster.js";
import { __setCapabilitiesForTests, parseOpenRouterCatalog } from "../../model/capabilities.js";
import { budgetState, forgetBudget, setDailyBudget, warnAboutBudget, warningReached } from "./budget.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** Locks the daily spending limit: what it counts, when it is reached, and that each warning goes out once. */
describe("daily spending limit", () => {
  afterAll(async () => {
    __setCapabilitiesForTests(null);
    await db.$client.end();
  });
  // $1 per million input tokens, $10 per million output, $0.10 per million cached.
  __setCapabilitiesForTests(
    parseOpenRouterCatalog({ data: [{ id: "a/cheap", pricing: { prompt: "0.000001", completion: "0.00001", input_cache_read: "0.0000001" } }] }),
  );

  it("counts running jobs, stops at the limit, and warns once per level", async () => {
    const account = await createAccount(db, { name: "Budget" });
    const agent = await createAgent(db, account.id, { name: "Nora", label: "Nora", role: "Teammate", jobDescription: "Works.", provider: "local", modelId: "a/cheap" });
    const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "Nora" }).returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    expect((await budgetState(db, account.id)).limitUsd).toBeNull();
    await setDailyBudget(db, account.id, 5);
    // A job still running: 10M in (9M cached), 100K out = $1 + $0.90 + $1 = $2.90.
    await db.insert(delegations).values({
      accountId: account.id, conversationId: room!.id, parentAgentId: agent.id, childAgentId: agent.id, task: "render", status: "running",
      inputTokens: 10_000_000, cacheReadTokens: 9_000_000, outputTokens: 100_000, provider: "local", modelId: "a/cheap",
    });
    const half = await budgetState(db, account.id);
    expect(half.spentUsd).toBeCloseTo(2.9, 6);
    expect(half.reached).toBe(false);
    expect(warningReached(half)).toBe(0.5);

    await warnAboutBudget(db, account.id, room!.id, half);
    await warnAboutBudget(db, account.id, room!.id, half);
    const sent = await db.select().from(notifications).where(and(eq(notifications.accountId, account.id)));
    expect(sent.map((row) => row.title)).toEqual(["50% of today's spending limit used"]);

    // Another job takes it past the limit.
    await db.insert(delegations).values({
      accountId: account.id, conversationId: room!.id, parentAgentId: agent.id, childAgentId: agent.id, task: "render 2", status: "done",
      inputTokens: 3_000_000, outputTokens: 0, provider: "local", modelId: "a/cheap",
    });
    forgetBudget(account.id);
    const over = await budgetState(db, account.id);
    expect(over.reached).toBe(true);
    await warnAboutBudget(db, account.id, room!.id, over);
    const after = await db.select().from(notifications).where(eq(notifications.accountId, account.id));
    expect(after.find((row) => row.title === "Daily spending limit reached")?.urgency).toBe("action-needed");

    // Clearing the limit lifts the stop.
    await setDailyBudget(db, account.id, null);
    expect((await budgetState(db, account.id)).reached).toBe(false);
  });
});
