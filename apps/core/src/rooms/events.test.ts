import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, events, members } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { appendEvent, listEventsSince, pruneEvents } from "./events.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks the durable event log: appends persist with monotonic cursors and
 * replay returns exactly what a reconnecting client missed, in order.
 */
describe("event log", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("replays only events after the cursor", async () => {
    const account = await createAccount(db, { name: "Log" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Logs.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "log" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const first = await appendEvent(db, {
      accountId: account.id,
      conversationId: room!.id,
      event: { type: "message", message: { id: "m1", body: "one" } as never },
    });
    await appendEvent(db, {
      accountId: account.id,
      conversationId: room!.id,
      event: { type: "message", message: { id: "m2", body: "two" } as never },
    });
    const third = await appendEvent(db, {
      accountId: account.id,
      conversationId: room!.id,
      event: { type: "run", run: { id: "r1", status: "done", error: null } },
    });

    const replayed = await listEventsSince(db, account.id, room!.id, first.id);
    expect(replayed.map((row) => row.id)).toEqual([first.id + 1, third.id]);
    expect(replayed[1]!.type).toBe("run");
    expect(await listEventsSince(db, account.id, room!.id, third.id)).toHaveLength(0);

    // Prune touches only rows older than retention: backdate one row, keep
    // the fresh ones (other parallel test files share this database).
    await db
      .update(events)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(events.id, first.id));
    await pruneEvents(db, 30);
    const remaining = await listEventsSince(db, account.id, room!.id, 0);
    expect(remaining.map((row) => row.id).includes(first.id)).toBe(false);
    expect(remaining.map((row) => row.id)).toContain(third.id);
  });
});
