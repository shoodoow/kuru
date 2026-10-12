import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { acquireRun, finishRun } from "../rooms/runs.js";
import { conversations, members } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { listPendingNotifications, markNotificationFailed, markNotificationSent, saveNotification, shouldPush } from "./notify.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks notify policy: pure matrix (watchers/flag/urgency) plus outbox
 * collapse — one active ping per run, updated instead of stacked.
 */
describe("notify policy", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("pushes only when nobody watches and the user allows it", () => {
    expect(shouldPush({ hasWatchers: true, agentNotify: true, urgency: "info" })).toBe(false);
    expect(shouldPush({ hasWatchers: true, agentNotify: true, urgency: "action-needed" })).toBe(false);
    expect(shouldPush({ hasWatchers: false, agentNotify: false, urgency: "info" })).toBe(false);
    expect(shouldPush({ hasWatchers: false, agentNotify: false, urgency: "action-needed" })).toBe(true);
    expect(shouldPush({ hasWatchers: false, agentNotify: true, urgency: "info" })).toBe(true);
  });

  it("collapses repeat pings from one run into a single pending row", async () => {
    const account = await createAccount(db, { name: "Ping" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Pings.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "ping" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const run = await acquireRun(db, account.id, room!.id);
    const runId = run.id;
    const first = await saveNotification(db, {
      accountId: account.id,
      conversationId: room!.id,
      runId,
      agentId: agent.id,
      title: "Working on it",
      body: "Step one.",
    });
    const second = await saveNotification(db, {
      accountId: account.id,
      conversationId: room!.id,
      runId,
      agentId: agent.id,
      title: "Still working",
      body: "Step two.",
      urgency: "action-needed",
    });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ title: "Still working", urgency: "action-needed", status: "pending" });

    const pending = await listPendingNotifications(db, 50, account.id);
    expect(pending.map((row) => row.id)).toContain(first.id);
    await markNotificationSent(db, first.id);
    expect((await listPendingNotifications(db, 50, account.id)).map((row) => row.id)).not.toContain(first.id);

    const other = await saveNotification(db, {
      accountId: account.id,
      conversationId: room!.id,
      title: "Other",
      body: "No run.",
    });
    await markNotificationFailed(db, other.id, "boom");
    expect(other.id).toBeDefined();
    await finishRun(db, runId);
  });
});
