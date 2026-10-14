/**
 * What an account's agents used today, this week or this month: tokens,
 * turns and background jobs, by hour or day, by agent and by model.
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

/** The windows the Usage page offers: today, the last seven days, this calendar month. */
export const USAGE_PERIODS = ["today", "week", "month"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** One bar: an hour of today, or a day. `models` is tokens (in + out) per model key. */
export type UsageBucket = { key: string } & UsageTotals & { models: Record<string, number> };

export type AccountUsage = {
  period: UsagePeriod;
  /** The zone the hours and days are cut in. */
  timezone: string;
  /** What one bar covers. */
  bucket: "hour" | "day";
  totals: UsageTotals;
  /** One entry per hour (today, up to now) or per day, oldest first, with zeros for quiet ones. */
  series: UsageBucket[];
  /** Agents that used anything in the period, heaviest first. */
  agents: ({ agentId: string; name: string; provider: string; modelId: string } & UsageTotals)[];
  /** Models that were used, heaviest first. `key` is "provider/model". */
  models: ({ key: string; provider: string; modelId: string } & UsageTotals)[];
};

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

/** The period asked for; an old client's `days` maps to the nearest one. */
export function usagePeriod(period: unknown, days?: unknown): UsagePeriod {
  if ((USAGE_PERIODS as readonly unknown[]).includes(period)) return period as UsagePeriod;
  return Number(days) === 7 ? "week" : Number(days) === 1 ? "today" : "month";
}

/**
 * Reads the account's usage for today, the last seven days, or this month.
 * Input: db, account id, the period.
 * Output: totals, a series of bars (hours for today, days otherwise), and
 * breakdowns by agent and by model.
 * Why per model: with a background model, one agent spends on two models,
 * and the bill differs per model. Each turn and job counts against the model
 * it ran on, as recorded when it ran. Usage from before models were recorded
 * is shown as "unknown": guessing from the agent's current model counted a
 * day of old work against a model the agent was switched to afterwards.
 */
export async function accountUsage(db: Db, accountId: string, period: UsagePeriod): Promise<AccountUsage> {
  const [account] = await db.select({ timezone: accounts.timezone }).from(accounts).where(eq(accounts.id, accountId));
  const timezone = safeZone(account?.timezone);
  const bucket = period === "today" ? "hour" : "day";
  const local = sql`(created_at at time zone ${timezone})`;
  const today = sql`(now() at time zone ${timezone})::date`;
  const since =
    period === "today" ? sql`${local}::date = ${today}` : period === "week" ? sql`${local}::date > ${today} - 7` : sql`${local}::date >= date_trunc('month', ${today})::date`;
  const key = bucket === "hour" ? sql`to_char(${local}, 'HH24')` : sql`to_char(${local}::date, 'YYYY-MM-DD')`;
  const rows = await db.execute(sql`
    with spent as (
      select c.owner_agent_id as agent_id, r.created_at, r.input_tokens, r.output_tokens, r.cache_read_tokens, 1 as turns, 0 as jobs,
        coalesce(r.provider, '') as provider, coalesce(r.model_id, '') as model_id
      from runs r join conversations c on c.id = r.conversation_id
      where r.account_id = ${accountId}
      union all
      select d.parent_agent_id, d.created_at, d.input_tokens, d.output_tokens, d.cache_read_tokens, 0, 1,
        coalesce(d.provider, ''), coalesce(d.model_id, '')
      from delegations d
      where d.account_id = ${accountId}
    )
    select
      agent_id as "agentId",
      ${key} as bucket,
      provider,
      model_id as "modelId",
      coalesce(sum(input_tokens), 0)::bigint as "inputTokens",
      coalesce(sum(output_tokens), 0)::bigint as "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::bigint as "cacheReadTokens",
      sum(turns)::int as turns,
      sum(jobs)::int as jobs
    from spent
    where ${since}
    group by 1, 2, 3, 4
  `);
  const list = rows as unknown as Record<string, unknown>[];
  const roster = await db
    .select({ id: agents.id, name: agents.name, provider: agents.provider, modelId: agents.modelId })
    .from(agents)
    .where(eq(agents.accountId, accountId));

  const totals: UsageTotals = { ...EMPTY };
  const byBucket = new Map<string, UsageBucket>();
  const byAgent = new Map<string, UsageTotals>();
  const byModel = new Map<string, { provider: string; modelId: string } & UsageTotals>();
  for (const row of list) {
    const used: UsageTotals = {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      turns: Number(row.turns),
      jobs: Number(row.jobs),
    };
    add(totals, used);
    const at = String(row.bucket);
    const agentId = String(row.agentId);
    const provider = String(row.provider ?? "");
    const modelId = String(row.modelId ?? "");
    const model = modelId ? `${provider}/${modelId}` : "unknown";
    if (!byBucket.has(at)) byBucket.set(at, { key: at, ...EMPTY, models: {} });
    const slot = byBucket.get(at)!;
    add(slot, used);
    slot.models[model] = (slot.models[model] ?? 0) + used.inputTokens + used.outputTokens;
    if (!byAgent.has(agentId)) byAgent.set(agentId, { ...EMPTY });
    add(byAgent.get(agentId)!, used);
    if (!byModel.has(model)) byModel.set(model, { provider, modelId, ...EMPTY });
    add(byModel.get(model)!, used);
  }

  // Every hour or day of the period appears, so a quiet one reads as a gap and not as missing data.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  const todayKey = `${parts.year}-${parts.month}-${parts.day}`;
  const keys: string[] = [];
  if (bucket === "hour") {
    for (let hour = 0; hour <= Number(parts.hour); hour++) keys.push(String(hour).padStart(2, "0"));
  } else {
    const end = Date.parse(`${todayKey}T00:00:00Z`);
    const count = period === "week" ? 7 : Number(parts.day);
    for (let index = count - 1; index >= 0; index--) keys.push(new Date(end - index * 86_400_000).toISOString().slice(0, 10));
  }
  const heaviest = (left: UsageTotals, right: UsageTotals) => right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens);
  return {
    period,
    timezone,
    bucket,
    totals,
    series: keys.map((at) => byBucket.get(at) ?? { key: at, ...EMPTY, models: {} }),
    agents: [...byAgent.entries()]
      .map(([agentId, used]) => {
        const agent = roster.find((row) => row.id === agentId);
        return { agentId, name: agent?.name ?? "Removed agent", provider: agent?.provider ?? "", modelId: agent?.modelId ?? "", ...used };
      })
      .sort(heaviest),
    models: [...byModel.entries()].map(([key, used]) => ({ key, ...used })).sort(heaviest),
  };
}
