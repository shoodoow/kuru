import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, jobs, members, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { createRoutine } from "./routines.js";
import { startScheduler } from "./scheduler.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks the scheduler: due routines fire with no HTTP call, and stop()
 * halts the loop. Model is stubbed; unrelated pending jobs are cleared first
 * so parallel files never trigger real turns here.
 */
describe("scheduler", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("fires a due routine and keeps ticking until stopped", async () => {
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.status, "pending"));
    const account = await createAccount(db, { name: "Tick" });
    const owner = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Ticks.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "tick" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: owner.id });
    const { routine } = await createRoutine(db, account.id, {
      agentId: owner.id,
      conversationId: room!.id,
      title: "Tick",
      instructions: "Tick.",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const seen: { jobs: number }[] = [];
    const onlyOurs = (job: { routineId: string }) => job.routineId === routine.id;
    const stop = startScheduler(db, {
      intervalMs: 200,
      generate: (async () => "ticked") as never,
      filterJob: onlyOurs,
      onTick: (info) => seen.push({ jobs: info.jobs }),
      onError: () => {},
    });
    const deadline = Date.now() + 8000;
    let fired = false;
    while (Date.now() < deadline) {
      const rows = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
      if (rows.some((row) => row.body === "ticked" && row.agentId === owner.id)) {
        fired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The reply lands before the tick that fired it reports back (the turn
    // still settles memory afterwards), so give that tick a moment to finish.
    const tickDeadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < tickDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stop();
    expect(fired).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    // A fresh scheduler with no due work ticks idle without firing.
    // Scoped to our routine so parallel files' due jobs stay theirs.
    const idle: number[] = [];
    const stopIdle = startScheduler(db, { intervalMs: 200, filterJob: onlyOurs, onTick: (info) => idle.push(info.jobs), onError: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 700));
    stopIdle();
    expect(idle.every((jobs) => jobs === 0)).toBe(true);
  });
});
