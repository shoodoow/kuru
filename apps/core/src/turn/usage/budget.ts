/**
 * The account's daily spending limit, and the warnings on the way to it.
 * Why: agents run around the clock. One bad day of background jobs spent
 * 180 million tokens before anyone looked. With a limit, background jobs and
 * scheduled runs stop when it is reached, and the person hears at half, at
 * four fifths and at the limit, instead of finding out from the bill.
 * Chats still answer: the person can always talk to their agents.
 * DB: reads accounts and usage; writes notifications.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { accounts, notifications } from "../../db/schema.js";
import { saveNotification } from "../../notify/notify.js";
import { accountUsage } from "./account-usage.js";

type Db = ReturnType<typeof getDb>;

export type BudgetState = {
  /** The limit in dollars, or null when none is set. */
  limitUsd: number | null;
  /** Estimated dollars spent today, in the account's time zone. */
  spentUsd: number;
  /** True when the limit is set and reached. */
  reached: boolean;
};

/** How long one reading is trusted: the check runs between every few worker steps. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; state: BudgetState }>();

/** The share of the limit at which the person is warned, once per day each. */
export const BUDGET_WARNINGS = [0.5, 0.8, 1] as const;

export async function budgetState(db: Db, accountId: string, now = Date.now()): Promise<BudgetState> {
  const cached = cache.get(accountId);
  if (cached && now - cached.at < CACHE_MS) return cached.state;
  const [account] = await db.select({ limit: accounts.dailyBudgetUsd }).from(accounts).where(eq(accounts.id, accountId));
  const limitUsd = typeof account?.limit === "number" && account.limit > 0 ? account.limit : null;
  // No limit: nothing to add up.
  const spentUsd = limitUsd === null ? 0 : ((await accountUsage(db, accountId, "today")).totals.estimatedUsd ?? 0);
  const state = { limitUsd, spentUsd, reached: limitUsd !== null && spentUsd >= limitUsd };
  cache.set(accountId, { at: now, state });
  return state;
}

/** Forgets the cached reading, after the limit was changed. */
export function forgetBudget(accountId: string): void {
  cache.delete(accountId);
}

/** The warning share reached, highest first, or null. */
export function warningReached(state: BudgetState): number | null {
  if (state.limitUsd === null) return null;
  const share = state.spentUsd / state.limitUsd;
  return [...BUDGET_WARNINGS].reverse().find((level) => share >= level) ?? null;
}

function warningTitle(level: number): string {
  return level >= 1 ? "Daily spending limit reached" : `${Math.round(level * 100)}% of today's spending limit used`;
}

/**
 * Tells the person once per day per level, in the chat where the spending happens.
 * Input: the state, and the conversation to attach the notification to.
 */
export async function warnAboutBudget(db: Db, accountId: string, conversationId: string, state: BudgetState): Promise<void> {
  const level = warningReached(state);
  if (level === null || state.limitUsd === null) return;
  const title = warningTitle(level);
  // Once a day: an earlier note with this title since the start of the local day (a day is close enough).
  const [already] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.accountId, accountId), eq(notifications.title, title), gte(notifications.createdAt, sql`now() - interval '20 hours'`)))
    .limit(1);
  if (already) return;
  const spent = `$${state.spentUsd.toFixed(2)} of $${state.limitUsd.toFixed(2)}`;
  await saveNotification(db, {
    accountId,
    conversationId,
    title,
    body:
      level >= 1
        ? `Your agents have used ${spent} today. Background jobs and scheduled runs are paused until tomorrow or until you raise the limit on the Usage page. Chats still answer.`
        : `Your agents have used ${spent} today (estimated). Open Usage to see which agent is spending it.`,
    urgency: level >= 1 ? "action-needed" : "info",
  });
}

/** What a worker or a spawn is told when the limit stops it. */
export function budgetReachedMessage(state: BudgetState): string {
  return (
    `DAILY LIMIT REACHED: the account has used about $${state.spentUsd.toFixed(2)} of its $${(state.limitUsd ?? 0).toFixed(2)} daily limit. ` +
    "Background work is paused until tomorrow or until the person raises the limit. Do not restart this job. Tell the person, in one line, what is paused."
  );
}

/** Sets or clears the limit. A limit of zero or less clears it. */
export async function setDailyBudget(db: Db, accountId: string, limitUsd: number | null): Promise<boolean> {
  const value = typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd > 0 ? limitUsd : null;
  const updated = await db.update(accounts).set({ dailyBudgetUsd: value }).where(eq(accounts.id, accountId)).returning({ id: accounts.id });
  forgetBudget(accountId);
  return updated.length > 0;
}
