/**
 * Deletes an account for good: every row it owns, the sign-in records of its
 * people, its computer and that computer's disk, and its own skills.
 * Why: "Delete Account" on the phone used to remove the account from a list on
 * the screen and nothing else. A person who asks for their account to be
 * deleted expects their data to be gone.
 * DB: deletes from every table that carries account_id, the auth tables, and accounts.
 */
import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { removeAccountComputer } from "../linux/linux.js";
import { noted } from "../log/logger.js";
import { accountSkillRoot } from "../skills/skills.js";

type Db = ReturnType<typeof getDb>;

/** Postgres's code for "another row still points at this one". */
const STILL_REFERENCED = "23503";

/**
 * Removes the account and everything under it.
 * The tables are found by their account_id column, not listed by hand, so a
 * table added later is covered. They point at one another, so each pass
 * deletes what it can and leaves the rest for the next; the order works itself
 * out. All of it happens in one transaction: the account is gone entirely or
 * not at all.
 * Input: db, the account id, and the skills folder when there is one.
 * Output: true when an account was deleted, false when there was none.
 */
export async function deleteAccount(db: Db, accountId: string, skillsRoot?: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const found = await tx.execute(sql`select 1 from accounts where id = ${accountId} for update`);
    if ((found as unknown as unknown[]).length === 0) return false;
    // Sign-in records hang off the person, not the account.
    await tx.execute(sql`delete from "session" where user_id in (select id from "user" where account_id = ${accountId})`);
    await tx.execute(sql`delete from "account" where user_id in (select id from "user" where account_id = ${accountId})`);
    const tables = (
      (await tx.execute(sql`
        select table_name as name from information_schema.columns
        where table_schema = current_schema() and column_name = 'account_id' and table_name <> 'accounts'
      `)) as unknown as { name: string }[]
    ).map((row) => row.name);
    let left = tables;
    while (left.length > 0) {
      const blocked: string[] = [];
      for (const table of left) {
        try {
          // Its own savepoint, so a refusal undoes this one delete and nothing else.
          await tx.transaction((inner) => inner.execute(sql`delete from ${sql.identifier(table)} where account_id = ${accountId}`));
        } catch (error) {
          if (errorCode(error) !== STILL_REFERENCED) throw error;
          blocked.push(table);
        }
      }
      if (blocked.length === left.length) {
        throw new Error(`Could not delete the account: rows in ${blocked.join(", ")} are still referenced by a table with no account_id.`);
      }
      left = blocked;
    }
    await tx.execute(sql`delete from accounts where id = ${accountId}`);
    return true;
  });
  if (!deleted) return false;
  // Outside the database nothing can be rolled back, so these come last and a failure is logged, not raised.
  await removeAccountComputer(accountId).catch(noted("Removing a deleted account's computer"));
  if (skillsRoot) {
    // Skills live on the computer removed above; this clears a folder an older version left on the server.
    try {
      rmSync(accountSkillRoot(skillsRoot, accountId), { recursive: true, force: true });
    } catch (error) {
      noted("Removing a deleted account's skills")(error);
    }
  }
  return true;
}

/** The database's error code, wherever the driver or drizzle put it. */
function errorCode(error: unknown): string | undefined {
  for (let current = error as { code?: unknown; cause?: unknown } | undefined; current; current = current.cause as typeof current) {
    if (typeof current.code === "string") return current.code;
  }
  return undefined;
}
