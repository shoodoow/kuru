import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents, conversations, delegations, members, messages } from "../db/schema.js";
import { exec } from "../linux/linux.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { executeRedirectWorker, executeSpawnWorker } from "../turn/tools/executors.js";
import { createGroupRoom, saveUserMessage } from "./rooms.js";
import { runDelegatedTurn } from "./turn.js";
import {
  addGroupMember,
  alreadyDelivered,
  checkWorker,
  claimDelivery,
  hireSubagent,
  listTeam,
  MAX_STARTS_PER_ASK,
  reclaimStaleDelegations,
  recordDelegation,
  runWorker,
  MAX_WORKERS_PER_PARENT,
  spawnWorker,
  startsSinceLastAsk,
  stopWorker,
  WorkerCapacityError,
} from "./subagents.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks team behavior: chief hires specialists into the same room, delegates
 * with attribution, lists the team, and hits depth/child caps instead of
 * fork-bombing the 20-member room.
 */
describe("subagents and teams", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("stops restarting work for one request after a set number of starts, until the person writes again", async () => {
    const account = await createAccount(db, { name: "Rounds" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const worker = await createAgent(db, account.id, agent("Hand"));
    await db.update(agents).set({ hidden: true, parentId: chief.id }).where(eq(agents.id, worker.id));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });
    const start = () =>
      db.insert(delegations).values({ accountId: account.id, conversationId: room!.id, parentAgentId: chief.id, childAgentId: worker.id, task: "Render the video.", status: "done" });
    const starts = () => startsSinceLastAsk(db, account.id, room!.id, chief.id);
    const ctx = (hiddenTurn: boolean) => ({ store: db, accountId: account.id, conversationId: room!.id, agentId: chief.id, hiddenTurn }) as never;

    // Work started before the person's message belongs to an earlier request.
    await start();
    await saveUserMessage(db, account.id, room!.id, { text: "Make me a 15 second video." });
    expect(await starts()).toBe(0);
    for (let round = 0; round < MAX_STARTS_PER_ASK; round += 1) await start();
    expect(await starts()).toBe(MAX_STARTS_PER_ASK);

    // A turn woken by a worker's result may not start it again.
    const spawn = (await executeSpawnWorker(ctx(true), { task: "Render the video again, properly this time." })) as { error?: string };
    expect(spawn.error).toMatch(/not started again without them/);
    const redirect = (await executeRedirectWorker(ctx(true), { workerId: worker.id, instruction: "Finish the render." })) as { error?: string };
    expect(redirect.error).toMatch(/not started again without them/);

    // The person writing again is a new request.
    await saveUserMessage(db, account.id, room!.id, { text: "Try once more." });
    expect(await starts()).toBe(0);
  });

  it("hires, lists, and delegates inside one room", async () => {
    const account = await createAccount(db, { name: "Team" });
    const chief = await createAgent(db, account.id, {
      name: "Chief",
      label: "Chief",
      role: "Teammate",
      jobDescription: "Coordinates.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: chief.id, title: "launch" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const child = await db.transaction(async (tx) =>
      hireSubagent(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "Researcher",
        role: "Teammate",
        jobDescription: "Researches accounts.",
      }),
    );
    expect(child.parentId).toBe(chief.id);
    expect(child.teamId).toBe(chief.id);

    const team = await db.transaction(async (tx) => listTeam(tx as never, account.id, chief.id));
    expect(team.map((m) => m.id)).toContain(child.id);

    const delegation = await db.transaction(async (tx) =>
      recordDelegation(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        agentId: child.id,
        task: "Score these 5 accounts.",
      }),
    );
    expect(delegation.status).toBe("running");

    await expect(
      db.transaction(async (tx) =>
        recordDelegation(tx as never, {
          accountId: account.id,
          conversationId: room!.id,
          parentAgentId: chief.id,
          agentId: chief.id,
          task: "self",
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses to hire into a private chat and leaves that membership unchanged", async () => {
    const account = await createAccount(db, { name: "Direct" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    await expect(
      hireSubagent(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "Researcher",
        role: "Teammate",
        jobDescription: "Researches accounts.",
      }),
    ).rejects.toThrow(/1:1/);

    const still = await db.select().from(members).where(eq(members.conversationId, room!.id));
    expect(still.map((row) => row.agentId)).toEqual([chief.id]);
  });

  it("creates a group without touching a private chat", async () => {
    const account = await createAccount(db, { name: "Group" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [direct] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: direct!.id, accountId: account.id, agentId: chief.id });

    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: chief.id,
      title: "Launch",
      memberIds: [bea.id],
    });
    expect(group.kind).toBe("group");
    expect(group.members.map((row) => row.agentId).sort()).toEqual([bea.id, chief.id].sort());

    const directMembers = await db.select().from(members).where(eq(members.conversationId, direct!.id));
    expect(directMembers.map((row) => row.agentId)).toEqual([chief.id]);
  });

  it("attributes a delegated reply to the parent and does not chain mentions", async () => {
    const account = await createAccount(db, { name: "Delegate" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: chief.id,
      title: "Handoff",
      memberIds: [bea.id],
    });
    const child = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: chief.id,
      label: "Researcher",
      role: "Teammate",
      jobDescription: "Researches accounts.",
    });
    const delegation = await recordDelegation(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: chief.id,
      agentId: child.id,
      task: "Score these accounts.",
    });
    const emitted: (typeof messages.$inferSelect)[] = [];
    const bubbles = await runDelegatedTurn(db, {
      accountId: account.id,
      conversationId: group.id,
      runId: randomUUID(),
      parentAgentId: chief.id,
      childAgentId: child.id,
      delegationId: delegation.id,
      task: "Score these accounts.",
      nextTime: () => new Date(),
      emittedMessages: emitted,
      emit: async () => {},
      delegationDepth: 1,
      generate: async () => "@Bea jump in with the scores",
    });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.agentId).toBe(child.id);
    expect(bubbles[0]?.viaAgentId).toBe(chief.id);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, group.id));
    expect(stored.filter((row) => row.agentId === bea.id)).toHaveLength(0);
    expect(stored.filter((row) => row.agentId === child.id)).toHaveLength(1);
  });

  it("runs a hidden worker to a result, stops one, and reclaims a stale one", async () => {
    const account = await createAccount(db, { name: "Workers" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Dig",
      role: "Teammate",
      jobDescription: "Digs through files.",
      task: "Find the ledger.",
    });
    const membership = await db
      .select()
      .from(members)
      .where(and(eq(members.conversationId, room!.id), eq(members.agentId, spawned.workerId)));
    expect(membership).toHaveLength(0);
    const [worker] = await db.select().from(agents).where(eq(agents.id, spawned.workerId));
    expect(worker?.hidden).toBe(true);

    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Find the ledger.",
      generate: async () => "Found three rows.",
    });
    const done = await checkWorker(db, account.id, spawned.workerId);
    expect(done.status).toBe("done");
    expect(done.result).toBe("Found three rows.");

    const running = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Wait",
      role: "Teammate",
      jobDescription: "Waits.",
      task: "Hold.",
    });
    expect(await stopWorker(db, account.id, running.workerId)).toEqual({ stopped: true });
    expect((await checkWorker(db, account.id, running.workerId)).status).toBe("failed");

    const stale = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Lost",
      role: "Teammate",
      jobDescription: "Lost.",
      task: "Hang.",
    });
    await db
      .update(delegations)
      .set({ heartbeatAt: new Date(Date.now() - 10_000) })
      .where(eq(delegations.id, stale.delegationId));
    const reclaimed = await reclaimStaleDelegations(db, 1_000);
    expect(reclaimed.map((row) => row.id)).toContain(stale.delegationId);
    expect((await checkWorker(db, account.id, stale.workerId)).status).toBe("failed");
  });

  it("reuses a free hidden worker instead of inserting another row", async () => {
    const account = await createAccount(db, { name: "Reuse" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const first = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Job",
      role: "Teammate",
      jobDescription: "Runs tasks.",
      task: "Task 1",
    });
    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: first.workerId,
      delegationId: first.delegationId,
      task: "Task 1",
      generate: async () => "Done",
    });
    const again = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Reuse",
      role: "Teammate",
      jobDescription: "Runs tasks.",
      task: "Task 2",
    });
    const [workerRows] = await db
      .select({ value: count() })
      .from(agents)
      .where(and(eq(agents.parentId, chief.id), eq(agents.accountId, account.id), eq(agents.hidden, true)));
    expect(workerRows?.value).toBe(1);
    expect(again.workerId).toBe(first.workerId);
    expect((await checkWorker(db, account.id, again.workerId)).status).toBe("running");
  });

  it("allocates different hidden workers for parallel jobs", async () => {
    const account = await createAccount(db, { name: "Parallel workers" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const jobs = await Promise.all(
      ["SEO", "Intel", "Positioning"].map((label) =>
        spawnWorker(db, {
          accountId: account.id,
          conversationId: room!.id,
          parentAgentId: chief.id,
          label,
          role: "Worker",
          jobDescription: "Runs one lane.",
          task: `Complete ${label}.`,
        }),
      ),
    );
    expect(new Set(jobs.map((job) => job.workerId)).size).toBe(3);
  });

  it("stores an oversized worker report as an artifact and returns a compact handoff", async () => {
    const account = await createAccount(db, { name: "Worker artifact" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Report",
      role: "Worker",
      jobDescription: "Writes reports.",
      task: "Produce the report.",
    });
    const full = `Findings: ${"evidence ".repeat(900)}\nWhat I did: researched.\nBlockers: none`;
    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Produce the report.",
      generate: async () => full,
    });
    const result = (await checkWorker(db, account.id, spawned.workerId)).result ?? "";
    const path = `/shared/worker-results/${spawned.delegationId}.md`;
    expect(result.length).toBeLessThan(4_000);
    expect(result).toContain(`Full report: ${path}`);
    expect((await exec(account.id, ["cat", path])).stdout).toBe(full);
  });

  it("does not let a stopped execution overwrite or deliver a stale result", async () => {
    const account = await createAccount(db, { name: "Stop guard" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Slow",
      role: "Worker",
      jobDescription: "Runs slowly.",
      task: "Complete a slow operation.",
    });
    let release!: (value: string) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const generated = new Promise<string>((resolve) => {
      release = resolve;
    });
    let settled = 0;
    const running = runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Complete a slow operation.",
      generate: async () => {
        started();
        return generated;
      },
      onSettled: () => {
        settled += 1;
      },
    });
    await began;
    expect(await stopWorker(db, account.id, spawned.workerId)).toEqual({ stopped: true });
    release("A stale success.");
    await running;
    const final = await checkWorker(db, account.id, spawned.workerId);
    expect(final.status).toBe("failed");
    expect(final.result).toBe("Stopped by the parent agent.");
    expect(settled).toBe(0);
  });

  it("throws WorkerCapacityError when every hidden worker is still running", async () => {
    const account = await createAccount(db, { name: "Full" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    for (let i = 0; i < MAX_WORKERS_PER_PARENT; i++) {
      await spawnWorker(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: `Busy-${i}`,
        role: "Teammate",
        jobDescription: "Runs tasks.",
        task: `Task ${i}`,
      });
    }
    await expect(
      spawnWorker(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "One more",
        role: "Teammate",
        jobDescription: "Runs tasks.",
        task: "Nope",
      }),
    ).rejects.toBeInstanceOf(WorkerCapacityError);
  });

  it("does not count hidden workers toward the teammate hire cap", async () => {
    const account = await createAccount(db, { name: "Split caps" });
    const cmo = await createAgent(db, account.id, agent("CMO"));
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: cmo.id,
      title: "Marketing",
      memberIds: [],
    });
    for (let i = 0; i < MAX_WORKERS_PER_PARENT; i++) {
      const spawned = await spawnWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        label: `Worker-${i}`,
        role: "Runner",
        jobDescription: "Runs tasks.",
        task: `Task ${i}`,
      });
      await runWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        childId: spawned.workerId,
        delegationId: spawned.delegationId,
        task: `Task ${i}`,
        generate: async () => "ok",
      });
    }
    const social = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: cmo.id,
      label: "Social",
      role: "Social manager",
      jobDescription: "Grow channels.",
    });
    expect(social.hidden).toBe(false);
    const team = await listTeam(db, account.id, cmo.id);
    expect(team.some((m) => m.id === social.id)).toBe(true);
    expect(team.length).toBe(1);
    expect(
      await spawnWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        label: "Reuse slot",
        role: "Runner",
        jobDescription: "Runs tasks.",
        task: "After teammates hire",
      }),
    ).toMatchObject({ status: "running" });
  });

  it("claims delivery exactly once and spots an already-posted result", async () => {
    const account = await createAccount(db, { name: "Delivery" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Dig",
      role: "Researcher",
      jobDescription: "Dig through files.",
      task: "Find the ledger.",
    });
    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Find the ledger.",
      generate: async () => "Found three rows in the ledger for March.",
    });
    expect(await claimDelivery(db, spawned.delegationId)).toBe(true);
    expect(await claimDelivery(db, spawned.delegationId)).toBe(false);
    expect(await alreadyDelivered(db, { accountId: account.id, conversationId: room!.id, parentAgentId: chief.id, result: "short" })).toBe(
      false,
    );
    await db.insert(messages).values({
      accountId: account.id,
      conversationId: room!.id,
      agentId: chief.id,
      body: "Quick note: Found three rows in the ledger for March. Details above.",
    });
    expect(
      await alreadyDelivered(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        result: "Found three rows in the ledger for March.",
      }),
    ).toBe(true);
  });

  it("hires a social manager with identity, grows the group, and keeps 1:1 shut", async () => {
    const account = await createAccount(db, { name: "CMO" });
    const cmo = await createAgent(db, account.id, {
      name: "CMO",
      label: "CMO",
      role: "Chief marketing officer",
      personality: "direct, warm",
      jobDescription: "Run marketing and build the team.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: cmo.id,
      title: "Marketing",
      memberIds: [],
    });
    const social = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: cmo.id,
      label: "Social",
      role: "Social manager",
      personality: "playful, terse",
      jobDescription: "Post daily and report numbers.",
    });
    expect(social.role).toBe("Social manager");
    expect(social.jobDescription).toBe("Post daily and report numbers.");
    const team = await listTeam(db, account.id, cmo.id);
    expect(team.find((m) => m.id === social.id)?.role).toBe("Social manager");

    const designer = await createAgent(db, account.id, agent("Designer"));
    const added = await addGroupMember(db, { accountId: account.id, conversationId: group.id, agentId: designer.id });
    expect(added.agentId).toBe(designer.id);

    const [direct] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: cmo.id, title: "dm" })
      .returning();
    await expect(addGroupMember(db, { accountId: account.id, conversationId: direct!.id, agentId: designer.id })).rejects.toThrow(
      /1:1/,
    );
  });

  describe('redirect_worker', () => {
  // NOTE: nested so the shared db client (closed in the outer afterAll)
  // stays open. Do not move these its to top level.
  it("continues the same worker when its run is no longer alive", async () => {
    const { executeRedirectWorker } = await import("../turn/tools/executors.js");
    const account = await createAccount(db, { name: "Redirect" });
    const parent = await createAgent(db, account.id, agent("Boss"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: parent.id, title: "job" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: parent.id });
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: parent.id,
      label: "Scout",
      role: "Researcher",
      jobDescription: "Researches sites.",
      task: "Goal: check the site. Inputs: https://example.com. Method: fetch it. Success: facts found. Return: Findings.",
    });
    const ctx = {
      db,
      store: db,
      accountId: account.id,
      conversationId: room!.id,
      agentId: parent.id,
      runId: randomUUID(),
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async () => {},
    };
    const out = (await executeRedirectWorker(ctx as never, {
      workerId: spawned.workerId,
      instruction: "The user just signed in on the box, so continue past the login wall now.",
    })) as { continued?: boolean; workerId: string; delegationId: string };
    // Marked running with no live run behind it: the stale attempt is closed
    // and the same worker carries on with the note as its instruction.
    expect(out.continued).toBe(true);
    expect(out.workerId).toBe(spawned.workerId);
    const rows = await db.select().from(delegations).where(eq(delegations.childAgentId, spawned.workerId));
    expect(rows.find((row) => row.id === spawned.delegationId)?.status).toBe("failed");
    const next = rows.find((row) => row.id === out.delegationId);
    expect(next?.id).not.toBe(spawned.delegationId);
    expect(next?.task).toContain("The user just signed in");
  });

  it("continues a finished worker with the new instruction", async () => {
    const { executeRedirectWorker } = await import("../turn/tools/executors.js");
    const account = await createAccount(db, { name: "RedirectDone" });
    const parent = await createAgent(db, account.id, agent("Boss"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: parent.id, title: "job" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: parent.id });
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: parent.id,
      label: "Scout",
      role: "Researcher",
      jobDescription: "Researches sites.",
      task: "Goal: check the site. Inputs: https://example.com. Method: fetch it. Success: facts found. Return: Findings.",
    });
    await stopWorker(db, account.id, spawned.workerId);
    const ctx = {
      db,
      store: db,
      accountId: account.id,
      conversationId: room!.id,
      agentId: parent.id,
      runId: randomUUID(),
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async () => {},
    };
    const out = (await executeRedirectWorker(ctx as never, {
      workerId: spawned.workerId,
      instruction: "Also grab the pricing page while you are there please.",
    })) as { continued?: boolean; workerId?: string; delegationId?: string };
    expect(out.continued).toBe(true);
    expect(out.workerId).toBe(spawned.workerId);
    const rows = await db.select().from(delegations).where(eq(delegations.childAgentId, spawned.workerId));
    expect(rows.find((row) => row.id === out.delegationId)?.task).toContain("pricing page");
  });
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
