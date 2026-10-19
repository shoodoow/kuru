/**
 * What one agent remembers, as the person sees it on the agent's Memory page,
 * and removing a fact for good.
 * Why: the person could not see what an agent knew, and the only way to clear
 * a wrong fact was asking the default agent, which can only overwrite it.
 * Overwritten facts piled up ("removed" markers) and old versions stayed.
 * DB: reads and deletes rows in `memories`, scoped by account.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, memories } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;

export type MemoryPageFact = {
  id: string;
  /** "agent": only this agent keeps it. "shared": every agent on the account reads it. */
  scope: "agent" | "shared";
  kind: string;
  subject: string | null;
  body: string;
  tentative: boolean;
  createdAt: string;
};

/**
 * Lists the current facts an agent reads: its own first, then the shared ones.
 * Input: db, account id, agent id. Output: facts newest first, or null when the agent is not on the account.
 */
export async function agentMemoryPage(db: Db, accountId: string, agentId: string): Promise<MemoryPageFact[] | null> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) return null;
  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        isNull(memories.supersededBy),
        ne(memories.kind, "profile"),
        or(eq(memories.scope, "user"), and(eq(memories.scope, "agent"), eq(memories.agentId, agentId))),
      ),
    )
    .orderBy(desc(memories.createdAt));
  const facts = rows.map(
    (row): MemoryPageFact => ({
      id: row.id,
      scope: row.scope === "user" ? "shared" : "agent",
      kind: row.kind,
      subject: row.subject,
      body: row.body,
      tentative: row.tentative,
      createdAt: row.createdAt.toISOString(),
    }),
  );
  return [...facts.filter((fact) => fact.scope === "agent"), ...facts.filter((fact) => fact.scope === "shared")];
}

/**
 * Deletes one fact the agent can see, with every older version it replaced.
 * Input: db, account id, agent id, memory id. Output: how many rows went, or null when the agent cannot see that fact.
 * A shared fact is removed for every agent, which the page says before the person confirms.
 */
export async function forgetMemory(db: Db, accountId: string, agentId: string, memoryId: string): Promise<{ removed: number } | null> {
  return db.transaction(async (tx) => {
    const [fact] = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.id, memoryId),
          eq(memories.accountId, accountId),
          ne(memories.kind, "profile"),
          or(eq(memories.scope, "user"), and(eq(memories.scope, "agent"), eq(memories.agentId, agentId))),
        ),
      );
    if (!fact) return null;
    // Older versions point at the newer one through superseded_by; follow the chain back.
    const chain = (await tx.execute(sql`
      with recursive older(id) as (
        select ${memoryId}::uuid
        union
        select m.id from memories m join older o on m.superseded_by = o.id where m.account_id = ${accountId}
      ) select id from older`)) as unknown as { id: string }[];
    const ids = chain.map((row) => row.id);
    const removed = await tx
      .delete(memories)
      .where(and(eq(memories.accountId, accountId), inArray(memories.id, ids)))
      .returning({ id: memories.id });
    return { removed: removed.length };
  });
}
