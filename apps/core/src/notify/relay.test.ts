import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents, conversations, devices, members, notifications } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { saveNotification } from "./notify.js";
import { relayNotifications } from "./relay.js";
import type { PushTicket } from "./push.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks the relay: in-app pings never touch Expo, flag-off info pings stay
 * in-app, action-needed pushes, dead tokens prune, and no-device fails visibly.
 */
describe("notify relay", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  async function fixture(notify: boolean) {
    const account = await createAccount(db, { name: `Relay${notify}${Date.now()}` });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Relays.",
      provider: "openai",
      modelId: "gpt-5",
    });
    await db.update(agents).set({ notify }).where(eq(agents.id, agent.id));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "relay" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });
    return { account, agent, room: room! };
  }

  async function pendingFor(accountId: string) {
    return (await db.select().from(notifications).where(eq(notifications.accountId, accountId))).filter(
      (row) => row.status === "pending",
    );
  }

  it("stays in-app for flag-off info, pushes action-needed", async () => {
    const { account, agent, room } = await fixture(false);
    const push = vi.fn(async (): Promise<PushTicket[]> => [{ status: "ok", id: "t1" }]);
    const receipts = vi.fn(async () => new Map([["t1", { ok: true as const }]]));
    await saveNotification(db, { accountId: account.id, conversationId: room.id, agentId: agent.id, title: "FYI", body: "Quiet." });
    await relayNotifications(db, push as never, receipts as never, account.id);
    expect(push).not.toHaveBeenCalled();

    await db.insert(devices).values({ accountId: account.id, expoPushToken: `ExponentPushToken[relay-${Date.now()}]` });
    await saveNotification(db, {
      accountId: account.id,
      conversationId: room.id,
      agentId: agent.id,
      title: "Blocked",
      body: "Need you.",
      urgency: "action-needed",
    });
    const counts = await relayNotifications(db, push as never, receipts as never, account.id);
    expect(push).toHaveBeenCalledTimes(1);
    expect(counts.pushed).toBe(1);
    expect((await pendingFor(account.id)).map((row) => row.title)).toEqual(["FYI"]);
  });

  it("prunes dead tokens and fails visibly with no devices", async () => {
    const { account, agent, room } = await fixture(true);
    const token = `ExponentPushToken[dead-${Date.now()}]`;
    await db.insert(devices).values({ accountId: account.id, expoPushToken: token });
    const push = vi.fn(async (): Promise<PushTicket[]> => [{ status: "ok", id: "t-dead" }]);
    const receipts = vi.fn(async () => new Map([["t-dead", { ok: false as const, error: "DeviceNotRegistered" }]]));
    await saveNotification(db, { accountId: account.id, conversationId: room.id, agentId: agent.id, title: "Hi", body: "There." });
    await relayNotifications(db, push as never, receipts as never, account.id);
    expect((await db.select().from(devices).where(eq(devices.expoPushToken, token)))).toHaveLength(0);

    await saveNotification(db, { accountId: account.id, conversationId: room.id, agentId: agent.id, title: "Lost", body: "No device." });
    const counts = await relayNotifications(db, push as never, receipts as never, account.id);
    expect(counts.failed).toBe(0);
    const rows = await db.select().from(notifications).where(eq(notifications.accountId, account.id));
    expect(rows.some((row) => row.title === "Lost" && row.status === "pending")).toBe(true);
  });
});
