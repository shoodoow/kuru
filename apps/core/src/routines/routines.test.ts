import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, jobs, members, messages, routines } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import {
  claimDue,
  createOwnRoutine,
  createRoutine,
  deleteOwnRoutine,
  deleteOwnRoutines,
  listDueJobs,
  listOwnRoutines,
  runDue,
  updateOwnRoutine,
} from "./routines.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

describe("routines", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("lets only one of two workers claim a due job", async () => {
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.status, "pending"));
    const account = await createAccount(db, { name: "Schedule" });
    const owner = await createAgent(db, account.id, agent("Ada"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "morning" })
      .returning();
    await createRoutine(db, account.id, {
      agentId: owner.id,
      conversationId: room!.id,
      title: "Morning hello",
      instructions: "Good morning.",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const [first, second] = await Promise.all([claimDue(db), claimDue(db)]);
    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("running");
  });

  it("runs a mentioned routine through one model call and leaves an unmentioned routine to the owner", async () => {
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.status, "pending"));
    const account = await createAccount(db, { name: "Due" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: bea.id, title: "due" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    await createRoutine(db, account.id, {
      agentId: ada.id,
      conversationId: room!.id,
      title: "Ledger check",
      instructions: "@Ada check the ledger",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const calls: string[] = [];
    const replies = await runDue(db, async ({ agentId }) => {
      calls.push(agentId);
      return "checked";
    });
    expect(calls).toEqual([ada.id]);
    expect(replies?.map((reply) => reply.agentId)).toEqual([ada.id]);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.some((message) => message.body === "checked" && message.agentId === ada.id)).toBe(true);
    const completed = await db.select().from(jobs).where(eq(jobs.status, "done"));
    expect(completed.some((job) => job.result === "checked")).toBe(true);
    // Routine body must never land as a user bubble.
    expect(stored.some((message) => message.agentId === null && message.body.includes("check the ledger"))).toBe(false);

    await createRoutine(db, account.id, {
      agentId: bea.id,
      conversationId: room!.id,
      title: "Ping",
      instructions: "anyone there",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 30_000).toISOString(),
    });
    calls.length = 0;
    await runDue(db, async ({ agentId }) => {
      calls.push(agentId);
      return "owner here";
    });
    expect(calls).toEqual([bea.id]);
    const after = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(after.some((message) => message.agentId === null && message.body === "anyone there")).toBe(false);
  });

  it("lets an agent manage only its own routines, and skips paused ones", async () => {
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.status, "pending"));
    const account = await createAccount(db, { name: "Own" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: ada.id, title: "mine" })
      .returning();

    await expect(
      createOwnRoutine(db, {
        accountId: account.id,
        conversationId: room!.id,
        agentId: ada.id,
        title: "Bad",
        instructions: "Bad.",
        cron: "not a cron",
      }),
    ).rejects.toThrow(/Unsupported/);

    const mine = await createOwnRoutine(db, {
      accountId: account.id,
      conversationId: room!.id,
      agentId: ada.id,
      title: "Morning note",
      instructions: "Morning note.",
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
    });
    expect(mine.timezone).toBe("Europe/Berlin");
    expect(mine.agentId).toBe(ada.id);

    expect(await updateOwnRoutine(db, account.id, bea.id, { routineId: mine.id, instructions: "Stolen." })).toBeNull();
    expect(await deleteOwnRoutine(db, account.id, bea.id, mine.id)).toBe(false);
    expect((await listOwnRoutines(db, account.id, ada.id)).map((row) => row.id)).toContain(mine.id);
    expect((await listOwnRoutines(db, account.id, bea.id)).map((row) => row.id)).not.toContain(mine.id);

    await db.update(jobs).set({ runAt: new Date(Date.now() - 60_000) }).where(eq(jobs.routineId, mine.id));
    await db.update(routines).set({ paused: true }).where(eq(routines.id, mine.id));
    const pausedDue = await listDueJobs(db, 100);
    expect(pausedDue.some((job) => job.routineId === mine.id)).toBe(false);

    await db.update(routines).set({ paused: false }).where(eq(routines.id, mine.id));
    const due = await listDueJobs(db, 100);
    expect(due.some((job) => job.routineId === mine.id)).toBe(true);

    const quiet = await createOwnRoutine(db, {
      accountId: account.id,
      conversationId: room!.id,
      agentId: ada.id,
      title: "Quiet",
      instructions: "Paused at birth.",
      cron: "*/15 * * * *",
      paused: true,
    });
    const quietJobs = await db.select().from(jobs).where(eq(jobs.routineId, quiet.id));
    expect(quietJobs).toHaveLength(0);
  });

  it("records last run status and clears many routines in one batch delete", async () => {
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.status, "pending"));
    const account = await createAccount(db, { name: "Batch" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: ada.id, title: "batch" })
      .returning();
    const one = await createOwnRoutine(db, {
      accountId: account.id,
      conversationId: room!.id,
      agentId: ada.id,
      title: "Ping once",
      instructions: "Ping once.",
      cron: "*/15 * * * *",
      timezone: "UTC",
    });
    const two = await createOwnRoutine(db, {
      accountId: account.id,
      conversationId: room!.id,
      agentId: ada.id,
      title: "Ping twice",
      instructions: "Ping twice.",
      cron: "*/15 * * * *",
      timezone: "UTC",
    });
    await db.update(jobs).set({ runAt: new Date(Date.now() - 60_000) }).where(eq(jobs.routineId, one.id));
    await runDue(db, async () => "ok");
    const listed = await listOwnRoutines(db, account.id, ada.id);
    const fired = listed.find((row) => row.id === one.id);
    expect(fired?.lastRunStatus).toBe("done");
    expect(fired?.lastRunAt).toBeTruthy();
    expect(fired?.recentRuns?.length).toBe(1);
    expect(fired?.recentRuns?.[0]?.status).toBe("done");

    const cleared = await deleteOwnRoutines(db, account.id, ada.id, { all: true });
    expect(cleared.deleted).toBe(2);
    expect(cleared.routineIds.sort()).toEqual([one.id, two.id].sort());
    expect(await listOwnRoutines(db, account.id, ada.id)).toEqual([]);
  });
});

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
