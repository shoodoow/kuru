import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";

type Database = Pick<ReturnType<typeof getDb>, "update">;

/**
 * Bumps every agent on the account so the cached skill catalog rotates.
 * Input: database and account id. Output: how many agents were bumped.
 */
export async function bumpAccountPromptVersions(db: Database, accountId: string): Promise<number> {
  const rows = await db
    .update(agents)
    .set({ promptVersion: sql`${agents.promptVersion} + 1` })
    .where(eq(agents.accountId, accountId))
    .returning({ id: agents.id });
  return rows.length;
}
