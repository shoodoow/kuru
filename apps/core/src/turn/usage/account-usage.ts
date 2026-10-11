/**
 * What an account's agents used over the last days: tokens, turns and
 * background jobs, by day and by agent.
 * Why: the per-chat ring shows one conversation. The person paying the model
 * bill needs the whole account in one place, and to see which agent spends it.
 * DB: reads runs, delegations, conversations, agents, accounts.
 */
import { eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { accounts, agents } from "../../db/schema.js";

type Db = ReturnType<typeof getDb>;

export type UsageTotals = {
  /** Everything sent to the model, cached or not. */
  inputTokens: number;
  outputTokens: number;
  /** The part of the input the provider served from its cache, usually billed lower. */
  cacheReadTokens: number;
  /** Turns the agents took in chats. */
  turns: number;
  /** Background jobs they ran. */
  jobs: number;
};

export type AccountUsage = {
  days: number;
  /** The zone the days are cut in. */
  timezone: string;
  totals: UsageTotals;
  /** One entry per day, oldest first, with zeros for quiet days. */
  daily: ({ day: string } & UsageTotals)[];
  /** Agents that used anything in the period, heaviest first. */
  agents: ({ agentId: string; name: string; provider: string; modelId: string } & UsageTotals)[];
};

export const USAGE_DAY_CHOICES = [7, 30, 90] as const;

const EMPTY: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, jobs: 0 };

function add(into: UsageTotals, row: UsageTotals): void {
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.cacheReadTokens += row.cacheReadTokens;
  into.turns += row.turns;
  into.jobs += row.jobs;
}

/** A zone Postgres will accept; anything else falls back to UTC. */
function safeZone(zone: string | null | undefined): string {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * Reads the account's usage for the last `days` days, today included.
 * Input: db, account id, the number of days (7, 30 or 90; anything else is 30).
 * Output: totals, a day-by-day series and a per-agent breakdown.
 */
export async function accountUsage(db: Db, accountId: string, days: number): Promise<AccountUsage> {
  const span = (USAGE_DAY_CHOICES as readonly number[]).includes(days) ? days : 30;
  const [account] = await db.select({ timezone: accounts.timezone }).from(accounts).where(eq(accounts.id, accountId));
  const timezone = safeZone(account?.timezone);
  // A turn belongs to the agent that owns its chat; a background job to the agent that started it.
  const rows = await db.execute(sql`
    with spent as (
      select c.owner_agent_id as agent_id, r.created_at, r.input_tokens, r.output_tokens, r.cache_read_tokens, 1 as turns, 0 as jobs
      from runs r join conversations c on c.id = r.conversation_id
      where r.account_id = ${accountId}
      union all
      select d.parent_agent_id, d.created_at, d.input_tokens, d.output_tokens, d.cache_read_tokens, 0, 1
      from delegations d
      where d.account_id = ${accountId}
    )
    select
      agent_id as "agentId",
      to_char((created_at at time zone ${timezone})::date, 'YYYY-MM-DD') as day,
      coalesce(sum(input_tokens), 0)::bigint as "inputTokens",
      coalesce(sum(output_tokens), 0)::bigint as "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::bigint as "cacheReadTokens",
      sum(turns)::int as turns,
      sum(jobs)::int as jobs
    from spent
    where (created_at at time zone ${timezone})::date > (now() at time zone ${timezone})::date - ${span}::int
    group by 1, 2
  `);
  const list = rows as unknown as Record<string, unknown>[];
  const roster = await db
    .select({ id: agents.id, name: agents.name, provider: agents.provider, modelId: agents.modelId })
    .from(agents)
    .where(eq(agents.accountId, accountId));

  const totals: UsageTotals = { ...EMPTY };
  const byDay = new Map<string, UsageTotals>();
  const byAgent = new Map<string, UsageTotals>();
  for (const row of list) {
    const used: UsageTotals = {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      turns: Number(row.turns),
      jobs: Number(row.jobs),
    };
    add(totals, used);
    const day = String(row.day);
    const agentId = String(row.agentId);
    if (!byDay.has(day)) byDay.set(day, { ...EMPTY });
    if (!byAgent.has(agentId)) byAgent.set(agentId, { ...EMPTY });
    add(byDay.get(day)!, used);
    add(byAgent.get(agentId)!, used);
  }

  // Every day of the period appears, so a quiet day reads as a gap and not as missing data.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const end = Date.parse(`${today}T00:00:00Z`);
  const daily = Array.from({ length: span }, (_unused, index) => {
    const day = new Date(end - (span - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, ...(byDay.get(day) ?? EMPTY) };
  });
  return {
    days: span,
    timezone,
    totals,
    daily,
    agents: [...byAgent.entries()]
      .map(([agentId, used]) => {
        const agent = roster.find((row) => row.id === agentId);
        return { agentId, name: agent?.name ?? "Removed agent", provider: agent?.provider ?? "", modelId: agent?.modelId ?? "", ...used };
      })
      .sort((left, right) => right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens)),
  };
}
