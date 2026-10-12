import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { account as authAccount, conversations, members, messages, runs, session, user } from "../db/schema.js";
import { createLinux, exec } from "../linux/linux.js";
import { saveBrief } from "../memory/memory.js";
import { deleteAccount } from "./delete-account.js";
import { createAccount, createAgent, ensureSupportAgent } from "./roster.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** An account with a signed-in person, two agents, a chat with a message and a run, and a computer. */
async function populated(name: string) {
  const account = await createAccount(db, { name });
  const agent = await createAgent(db, account.id, { name: "Ada", label: "Ada", role: "Teammate", jobDescription: "Works.", provider: "openai", modelId: "gpt-5" });
  await ensureSupportAgent(db, account.id);
  const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "chat" }).returning();
  await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });
  await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, agentId: agent.id, body: "hello" });
  await db.insert(runs).values({ accountId: account.id, conversationId: room!.id, status: "done" });
  await saveBrief(db, account.id, "Runs a small studio and wants weekly reports.");
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name, email: `${userId}@example.com`, accountId: account.id });
  await db.insert(session).values({ id: randomUUID(), userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await db.insert(authAccount).values({ id: randomUUID(), userId, accountId: "google-sub", providerId: "google" });
  return { accountId: account.id, userId };
}

/** How many rows anywhere still carry this account id. */
async function rowsLeft(accountId: string): Promise<number> {
  const tables = (await db.execute(
    sql`select table_name as name from information_schema.columns where table_schema = current_schema() and column_name = 'account_id'`,
  )) as unknown as { name: string }[];
  let total = 0;
  for (const table of tables) {
    const [row] = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(table.name)} where account_id::text = ${accountId}`)) as unknown as { n: number }[];
    total += row!.n;
  }
  return total;
}

describe("deleting an account", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("removes every row, the sign-in records and the computer, and leaves other accounts alone", async () => {
    const mine = await populated("Leaving");
    const other = await populated("Staying");
    // Give the leaving account a real computer with a file on it.
    await createLinux(mine.accountId);
    await exec(mine.accountId, ["sh", "-c", "echo secret > /shared/notes.txt"]);
    const otherBefore = await rowsLeft(other.accountId);

    expect(await deleteAccount(db, mine.accountId)).toBe(true);

    expect(await rowsLeft(mine.accountId)).toBe(0);
    const [gone] = (await db.execute(sql`select count(*)::int as n from accounts where id = ${mine.accountId}`)) as unknown as { n: number }[];
    expect(gone!.n).toBe(0);
    const [signIns] = (await db.execute(
      sql`select (select count(*) from "session" where user_id = ${mine.userId})::int + (select count(*) from "account" where user_id = ${mine.userId})::int as n`,
    )) as unknown as { n: number }[];
    expect(signIns!.n).toBe(0);
    // The computer is gone, and its disk with it.
    await expect(exec(mine.accountId, ["cat", "/shared/notes.txt"])).rejects.toThrow(/no such container/i);

    expect(await rowsLeft(other.accountId)).toBe(otherBefore);
    // A second delete finds nothing.
    expect(await deleteAccount(db, mine.accountId)).toBe(false);
  }, 120_000);
});
