import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, jobs, messages, routines } from "../db/schema.js";
import { remember } from "../memory/memory.js";
import { workerLessons } from "../memory/worker-lessons.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { quietReport, routineNotesPath, settleRoutineRun } from "./routine-worker.js";
import { createOwnRoutine, updateOwnRoutine } from "./routines.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);
const base = { provider: "openai", modelId: "gpt-5", role: "Lead", jobDescription: "Runs the shop." };

async function setUp(name: string) {
  const account = await createAccount(db, { name });
  const ethan = await createAgent(db, account.id, { ...base, name: "Ethan", label: "Ethan" });
  const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: ethan.id, title: "Ethan" }).returning();
  const [said] = await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, body: "Use 1280x769 for gig images." }).returning();
  return { account, ethan, room: room!, messageId: said!.id };
}

describe("routine workers", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("stores a worker routine with its kind, skills, brief file and a notes file", async () => {
    const { account, ethan, room } = await setUp("routine-worker");
    const routine = await createOwnRoutine(db, {
      accountId: account.id,
      conversationId: room.id,
      agentId: ethan.id,
      title: "Fiverr inbox sweep",
      instructions: "Answer new buyer messages.",
      cron: "0 9 * * *",
      runAs: "worker",
      kind: "browser",
      skills: ["chrome-devtools"],
      briefFile: "/shared/briefs/fiverr-inbox.md",
    });
    expect(routine).toMatchObject({ runsAs: "worker", workerKind: "browser", workerSkills: ["chrome-devtools"], briefPath: "/shared/briefs/fiverr-inbox.md" });
    expect(routineNotesPath(routine, "/home/ethan")).toMatch(/^\/home\/ethan\/notes\/routines\/fiverr-inbox-sweep-[0-9a-f]{8}\.md$/);
    const cleared = await updateOwnRoutine(db, account.id, ethan.id, { routineId: routine.id, briefFile: "", runAs: "agent" });
    expect(cleared).toMatchObject({ briefPath: null, runsAs: "agent" });
    await expect(
      createOwnRoutine(db, { accountId: account.id, conversationId: room.id, agentId: ethan.id, title: "x", instructions: "y", cron: "0 9 * * *", briefFile: "/etc/passwd" }),
    ).rejects.toThrow();
  });

  it("makes a finished worker's report the run's result, and stays quiet when there is nothing new", async () => {
    const { account, ethan, room } = await setUp("routine-settle");
    const routine = await createOwnRoutine(db, { accountId: account.id, conversationId: room.id, agentId: ethan.id, title: "Sweep", instructions: "Sweep.", cron: "0 9 * * *", runAs: "worker" });
    const delegationId = crypto.randomUUID();
    const [job] = await db.insert(jobs).values({ accountId: account.id, routineId: routine.id, status: "running", runAt: new Date(), delegationId }).returning();
    expect(await settleRoutineRun(db, delegationId, "done", "**NOTHING NEW**\n**Findings:** inbox empty.")).toEqual({ routine: true, quiet: true });
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(saved).toMatchObject({ status: "done", result: "**NOTHING NEW**\n**Findings:** inbox empty." });
    const [after] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(after?.lastRunStatus).toBe("done");
    expect(await settleRoutineRun(db, crypto.randomUUID(), "done", "NOTHING NEW")).toEqual({ routine: false, quiet: false });
  });

  it("wakes the agent for anything but a plain quiet report", () => {
    expect(quietReport("NOTHING NEW\nAll good.")).toBe(true);
    expect(quietReport("FOR THE PERSON: two new orders.")).toBe(false);
    expect(quietReport("NOTHING NEW\nNEEDS_PERSON: sign in to Fiverr")).toBe(false);
    expect(quietReport("Findings: there was nothing new in the inbox but NOTHING NEW appears late in a long report")).toBe(false);
  });

  it("hands workers the agent's procedures and nobody else's", async () => {
    const { account, ethan, messageId } = await setUp("routine-lessons");
    const nora = await createAgent(db, account.id, { ...base, name: "Nora", label: "Nora" });
    await remember(db, account.id, { scope: "agent", agentId: ethan.id, kind: "procedure", body: "Upload gig images at 1280x769.", messageId });
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: "Render videos at 1080x1920.", messageId });
    await remember(db, account.id, { scope: "agent", agentId: ethan.id, kind: "fact", body: "Gig 2 is about 3D configurators.", messageId });
    const lessons = await workerLessons(db, account.id, ethan.id, "Publish gig 3");
    expect(lessons).toContain("Upload gig images at 1280x769.");
    expect(lessons).not.toContain("1080x1920");
    expect(lessons).not.toContain("Gig 2 is about");
    expect(await workerLessons(db, account.id, nora.id, "x")).toContain("1080x1920");
  });
});
