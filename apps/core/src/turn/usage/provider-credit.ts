/**
 * What is left to spend at each model provider, and whether web search works.
 * Why: agents run around the clock on prepaid credit. The person learned the
 * key was nearly empty only when jobs started failing with "can only afford".
 * The Usage page now shows the balance next to what is being spent.
 * Providers that publish a balance: OpenRouter (the key's limit and use, and
 * the account's balance when the key may read it) and DeepSeek. Anthropic,
 * OpenAI and xAI have no balance API: the page says so and links nowhere.
 * DB: reads provider keys and tool keys. Network: one call per provider, cached.
 */
import type { getDb } from "../../db/client.js";
import { keyFor, listProviderKeys } from "../../keys/keys.js";
import { toolKeyFor } from "../../keys/tools.js";
import { searchOutage } from "../../computer/search.js";
import { creditOutage } from "../../model/credit.js";

type Db = ReturnType<typeof getDb>;

export type ProviderCredit = {
  /** The provider as the account names it (`local` for an OpenAI-compatible address). */
  provider: string;
  /** Who is actually billed: "OpenRouter", "DeepSeek", "Anthropic". */
  service: string;
  /** Dollars left on the account, when the provider tells. */
  balanceUsd: number | null;
  /** The key's own spending limit and what is left of it, when it has one. */
  keyLimitUsd: number | null;
  keyRemainingUsd: number | null;
  /** What the key spent today and this month, when the provider tells. */
  usedTodayUsd: number | null;
  usedMonthUsd: number | null;
  /** A plain sentence when something could not be read. */
  note: string | null;
};

export type SearchStatus = {
  provider: "exa" | "brave" | "none";
  /** Set while search is known to be down for this account. */
  down: string | null;
};

export type CreditReport = {
  providers: ProviderCredit[];
  search: SearchStatus;
  /** Set while the account's background work is paused because a provider refused for lack of credit. */
  outOfCredit: boolean;
};

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; report: CreditReport }>();
const TIMEOUT_MS = 10_000;

function number(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function empty(provider: string, service: string, note: string | null): ProviderCredit {
  return { provider, service, balanceUsd: null, keyLimitUsd: null, keyRemainingUsd: null, usedTodayUsd: null, usedMonthUsd: null, note };
}

async function getJson(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The OpenRouter key's limit and use, and the account balance when the key may read it. */
export async function openRouterCredit(provider: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ProviderCredit> {
  const result = empty(provider, "OpenRouter", null);
  const key = await getJson("https://openrouter.ai/api/v1/key", apiKey, fetchImpl).catch(() => null);
  const data = (key?.body as { data?: Record<string, unknown> } | null)?.data;
  if (!key || key.status !== 200 || !data) return { ...result, note: "OpenRouter did not answer for this key." };
  result.keyLimitUsd = number(data.limit);
  result.keyRemainingUsd = number(data.limit_remaining);
  result.usedTodayUsd = number(data.usage_daily);
  result.usedMonthUsd = number(data.usage_monthly);
  // The account balance needs a management key; an ordinary key is refused with 403.
  const credits = await getJson("https://openrouter.ai/api/v1/credits", apiKey, fetchImpl).catch(() => null);
  const totals = (credits?.body as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
  const bought = number(totals?.total_credits);
  const used = number(totals?.total_usage);
  if (credits?.status === 200 && bought !== null && used !== null) result.balanceUsd = bought - used;
  else if (result.keyLimitUsd === null) result.note = "This key has no spending limit, and the account balance needs an OpenRouter management key.";
  return result;
}

/** DeepSeek's balance in dollars (or the first currency it reports). */
export async function deepSeekCredit(provider: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ProviderCredit> {
  const result = empty(provider, "DeepSeek", null);
  const answer = await getJson("https://api.deepseek.com/user/balance", apiKey, fetchImpl).catch(() => null);
  const infos = (answer?.body as { balance_infos?: { currency?: string; total_balance?: string }[] } | null)?.balance_infos ?? [];
  const usd = infos.find((info) => info.currency === "USD") ?? infos[0];
  if (!usd) return { ...result, note: "DeepSeek did not answer for this key." };
  result.balanceUsd = number(usd.total_balance);
  if (usd.currency && usd.currency !== "USD") result.note = `Balance is in ${usd.currency}.`;
  return result;
}

/** Which service a configured provider really bills through. */
export function billedBy(provider: string, baseUrl: string | null): "openrouter" | "deepseek" | "anthropic" | "openai" | "xai" | "other" {
  const host = (() => {
    try {
      return baseUrl ? new URL(baseUrl).hostname : "";
    } catch {
      return "";
    }
  })();
  if (host.endsWith("openrouter.ai")) return "openrouter";
  if (host.endsWith("deepseek.com")) return "deepseek";
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai" && !host) return "openai";
  if (provider === "xai") return "xai";
  return "other";
}

const NO_BALANCE_API: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
};

export async function creditReport(db: Db, accountId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<CreditReport> {
  const cached = cache.get(accountId);
  if (cached && now - cached.at < CACHE_MS) return cached.report;
  const keys = (await listProviderKeys(db, accountId)).filter((key) => key.configured);
  const providers = await Promise.all(
    keys.map(async (stored): Promise<ProviderCredit> => {
      const service = billedBy(stored.provider, stored.baseUrl);
      const credential = await keyFor(db, accountId, stored.provider).catch(() => null);
      if (!credential?.apiKey) return empty(stored.provider, stored.provider, "No key is saved.");
      if (service === "openrouter") return openRouterCredit(stored.provider, credential.apiKey, fetchImpl);
      if (service === "deepseek") return deepSeekCredit(stored.provider, credential.apiKey, fetchImpl);
      const name = NO_BALANCE_API[service];
      return empty(stored.provider, name ?? stored.baseUrl ?? stored.provider, `${name ?? "This provider"} does not publish a balance; check its own console.`);
    }),
  );
  const [exa, brave] = await Promise.all([toolKeyFor(db, accountId, "exa").catch(() => null), toolKeyFor(db, accountId, "brave").catch(() => null)]);
  const report: CreditReport = {
    providers,
    search: { provider: exa ? "exa" : brave ? "brave" : "none", down: searchOutage(accountId)?.reason ?? null },
    outOfCredit: creditOutage(accountId) !== null,
  };
  cache.set(accountId, { at: now, report });
  return report;
}
