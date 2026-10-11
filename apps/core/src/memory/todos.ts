import { todoWriteInputSchema, type TodoItem } from "@kuru/agent-tools";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { agentTodos } from "../db/schema.js";

/**
 * Replaces one agent's worklist wholesale.
 * Why: opencode's todowrite pattern — multi-step jobs stay tracked across
 * turns and restarts in one row per agent, instead of living in prompt memory
 * that compacts away. Replace (not patch) keeps client and server trivially
 * consistent.
 * Input: store, account/agent ids, items [{content, status}]. Output: saved items.
 */
export async function todoWrite(store: Store, accountId: string, agentId: string, todos: TodoItem[]): Promise<TodoItem[]> {
  const data = todoWriteInputSchema.parse({ todos });
  const [row] = await store
    .insert(agentTodos)
    .values({ accountId, agentId, items: data.todos })
    .onConflictDoUpdate({
      target: [agentTodos.accountId, agentTodos.agentId],
      set: { items: data.todos, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Todo write returned no row.");
  return row.items as TodoItem[];
}

/**
 * Reads one agent's current worklist.
 * Why: agents re-orient after compaction, routine wakes, or worker revival by
 * reading this instead of guessing what was in flight.
 * Input: store, account/agent ids. Output: items (empty when never written).
 */
export async function todoList(store: Store, accountId: string, agentId: string): Promise<TodoItem[]> {
  const [row] = await store
    .select({ items: agentTodos.items })
    .from(agentTodos)
    .where(and(eq(agentTodos.accountId, accountId), eq(agentTodos.agentId, agentId)));
  if (!row) return [];
  return (Array.isArray(row.items) ? row.items : []) as TodoItem[];
}
