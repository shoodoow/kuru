import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, members, runs } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { acquireRun, failRun, findRunningRun, finishRun, heartbeatRun, reclaimStaleRuns } from "./runs.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks run-ledger behavior: one running run per room, wait-acquire
 * serialization, heartbeat freshness, and stale-crash reclaim.
 */
describe("run ledger", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("serializes concurrent claims and times out with room-busy", async () => {
    const account = await createAccount(db, { name: "Ledger" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Holds turns.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "ledger" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const first = await acquireRun(db, account.id, room!.id);
    expect(await findRunningRun(db, account.id, room!.id)).toMatchObject({ id: first.id });

    // Second claim with zero timeout fails fast instead of wedging.
    await expect(acquireRun(db, account.id, room!.id, "turn", 0)).rejects.toThrow(/busy/);

    // With a waiter: finishes the first, the second proceeds (lock-queue parity).
    const waiting = acquireRun(db, account.id, room!.id, "turn", 5000, 50);
    await finishRun(db, first.id);
    const second = await waiting;
    expect(second.id).not.toBe(first.id);
    await finishRun(db, second.id);
    expect(await findRunningRun(db, account.id, room!.id)).toBeUndefined();
  });

  it("reclaims stale running runs as failed", async () => {
    const account = await createAccount(db, { name: "Reclaim" });
    const agent = await createAgent(db, account.id, {
      name: "Bea",
      label: "Bea",
      role: "Teammate",
      jobDescription: "Crashes.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "reclaim" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const run = await acquireRun(db, account.id, room!.id);
    const before = (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!.heartbeatAt;
    await heartbeatRun(db, run.id);
    const after = (await db.select().from(runs).where(eq(runs.id, run.id)))[0]!.heartbeatAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());

    // Fresh heartbeat: not reclaimed. Ancient heartbeat: reclaimed as failed.
    expect((await reclaimStaleRuns(db, 60_000)).map((row) => row.id)).not.toContain(run.id);
    await db.update(runs).set({ heartbeatAt: new Date(Date.now() - 3600_000) }).where(eq(runs.id, run.id));
    const reclaimed = await reclaimStaleRuns(db, 60_000);
    expect(reclaimed.map((row) => row.id)).toContain(run.id);
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0]).toMatchObject({ status: "failed" });

    await failRun(db, run.id, "x".repeat(5000));
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0]!.error!.length).toBeLessThanOrEqual(2000);
  });
});
