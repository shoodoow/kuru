/**
 * Removes one of the person's agents for good: the agent, its background
 * workers, its private chat, and what it kept for itself.
 * Why: an agent the person no longer wants (a role replaced by a better one)
 * stayed in every other agent's roster and could still be messaged or given
 * work. Facts it learned about the person stay: they belong to the person,
 * and only lose the link to the chat they came from.
 * DB: one transaction over the tables that point at the agent, its chat and its messages.
 */
import { sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";

type Db = ReturnType<typeof getDb>;

/** A fire that cannot go ahead, with a sentence the agent can pass on. */
export class FireAgentError extends Error {}

export type FiredAgent = {
  name: string;
  label: string;
  chats: number;
  messages: number;
  workers: number;
  /** Its Linux user on the account's computer, whose home the caller removes once the rows are gone. */
  linuxProfile: string | null;
};

/**
 * Deletes one top-level agent of an account.
 * Input: db, account id, agent id. Output: what was removed.
 * Throws FireAgentError for the default agent, a worker, an agent that leads a
 * group (the group would lose its owner), or one in the middle of a turn.
 */
export async function deleteAgent(db: Db, accountId: string, agentId: string): Promise<FiredAgent> {
  return db.transaction(async (tx) => {
    const run = async <T>(query: ReturnType<typeof sql>): Promise<T[]> => (await tx.execute(query)) as unknown as T[];
    const [agent] = await run<{ id: string; name: string; label: string; kind: string; hidden: boolean; parent_id: string | null; linux_profile: string | null }>(sql`
      select id, name, label, kind, hidden, parent_id, linux_profile from agents where id = ${agentId} and account_id = ${accountId} for update`);
    if (!agent) throw new FireAgentError("There is no such agent on this account.");
    if (agent.kind === "support") throw new FireAgentError("The default agent cannot be removed.");
    // A worker is hidden and belongs to an agent. A hidden agent of its own (the person hid it) can still be removed.
    if (agent.hidden && agent.parent_id) throw new FireAgentError("That is a background worker, not an agent; stop it with stop_worker.");
    const groups = await run<{ title: string }>(sql`
      select title from conversations where account_id = ${accountId} and owner_agent_id = ${agentId} and kind = 'group'`);
    if (groups.length > 0) {
      throw new FireAgentError(
        `${agent.label || agent.name} leads ${groups.map((group) => `"${group.title}"`).join(", ")}. Delete those groups first, or keep the agent.`,
      );
    }

    const workerRows = await run<{ id: string }>(sql`
      select id from agents where account_id = ${accountId} and parent_id = ${agentId} and hidden = true`);
    const ids = [agentId, ...workerRows.map((row) => row.id)];
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const chatRows = await run<{ id: string }>(sql`
      select id from conversations where account_id = ${accountId} and owner_agent_id = ${agentId}`);
    const chats = chatRows.map((row) => row.id);
    const chatList = chats.length > 0 ? sql.join(chats.map((id) => sql`${id}::uuid`), sql`, `) : sql`null::uuid`;
    const busy = await run<{ id: string }>(sql`
      select id from runs where status = 'running' and conversation_id in (${chatList}) limit 1`);
    if (busy.length > 0) throw new FireAgentError(`${agent.label || agent.name} is in the middle of a turn. Try again in a minute.`);

    // Everything below is scoped by account as well as by id, so nothing outside it can be touched.
    const mine = sql`account_id = ${accountId}`;
    await tx.execute(sql`create temporary table fired_messages on commit drop as
      select id from messages where ${mine} and (conversation_id in (${chatList}) or agent_id in (${idList}))`);
    const [{ count: messageCount } = { count: 0 }] = await run<{ count: number }>(sql`select count(*)::int as count from fired_messages`);
    const firedMessages = sql`(select id from fired_messages)`;
    const firedRuns = sql`(select id from runs where ${mine} and conversation_id in (${chatList}))`;
    const firedRoutines = sql`(select id from routines where ${mine} and (agent_id in (${idList}) or conversation_id in (${chatList})))`;

    // What only this agent knew goes; what it learned about the person stays, without its source.
    await tx.execute(sql`delete from memories where ${mine} and agent_id in (${idList})`);
    await tx.execute(sql`update memories set message_id = null where ${mine} and message_id in ${firedMessages}`);
    await tx.execute(sql`update notifications set message_id = null where ${mine} and message_id in ${firedMessages}`);
    await tx.execute(sql`update notifications set run_id = null where ${mine} and run_id in ${firedRuns}`);
    await tx.execute(sql`delete from notifications where ${mine} and (agent_id in (${idList}) or conversation_id in (${chatList}))`);
    await tx.execute(sql`update tool_approvals set message_id = null where ${mine} and message_id in ${firedMessages}`);
    await tx.execute(sql`delete from tool_approvals where ${mine} and (agent_id in (${idList}) or conversation_id in (${chatList}))`);
    await tx.execute(sql`delete from summary_items where ${mine} and (conversation_id in (${chatList}) or message_id in ${firedMessages})`);
    await tx.execute(sql`delete from reactions where ${mine} and agent_id in (${idList})`);
    await tx.execute(sql`delete from jobs where ${mine} and routine_id in ${firedRoutines}`);
    await tx.execute(sql`delete from routines where ${mine} and id in ${firedRoutines}`);
    await tx.execute(sql`delete from events where ${mine} and (conversation_id in (${chatList}) or run_id in ${firedRuns})`);
    await tx.execute(sql`delete from work_log where ${mine} and (agent_id in (${idList}) or conversation_id in (${chatList}))`);
    await tx.execute(sql`delete from delegations where ${mine} and (parent_agent_id in (${idList}) or child_agent_id in (${idList}) or conversation_id in (${chatList}))`);
    await tx.execute(sql`delete from members where ${mine} and (agent_id in (${idList}) or conversation_id in (${chatList}))`);
    await tx.execute(sql`delete from proposals where ${mine} and agent_id in (${idList})`);
    await tx.execute(sql`delete from agent_todos where ${mine} and agent_id in (${idList})`);
    await tx.execute(sql`update messages set via_agent_id = null where ${mine} and via_agent_id in (${idList})`);
    await tx.execute(sql`update messages set source_conversation_id = null where ${mine} and source_conversation_id in (${chatList})`);
    await tx.execute(sql`delete from messages where ${mine} and id in ${firedMessages}`);
    await tx.execute(sql`delete from runs where ${mine} and conversation_id in (${chatList})`);
    await tx.execute(sql`delete from conversations where ${mine} and id in (${chatList})`);
    // Teammates it hired stay with the person; they just have no lead above them now.
    await tx.execute(sql`update agents set parent_id = null where ${mine} and parent_id = ${agentId} and hidden = false`);
    await tx.execute(sql`delete from agents where ${mine} and id in (${idList})`);
    return { name: agent.name, label: agent.label, chats: chats.length, messages: messageCount, workers: workerRows.length, linuxProfile: agent.linux_profile };
  });
}
