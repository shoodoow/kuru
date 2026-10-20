import { exec } from "../linux/linux.js";

export type SearchResult = { title: string; url: string; snippet: string; date?: string };
export type SearchProvider = "brave" | "exa" | "duckduckgo";

/** Kinds of page a search can be narrowed to (Exa's categories). */
export const SEARCH_CATEGORIES = ["news", "github", "tweet", "research paper", "pdf", "personal site"] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

/**
 * What narrows a search: how recent, which sites, which kind of page.
 * Why: without them a worker that needed "posts from the last two days on
 * reddit.com and upwork.com" opened the sites in the browser one page per
 * step (74 page visits in one 133-step run) instead of asking search for them.
 */
export type SearchFilters = { sinceDays?: number; sites?: string[]; category?: SearchCategory };

/** Brave's freshness window for a number of days. */
export function braveFreshness(days: number): string {
  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  return "py";
}

/** The query with `site:` terms for engines that take no site list. */
export function withSites(query: string, sites: string[] | undefined): string {
  if (!sites || sites.length === 0) return query;
  const terms = sites.map((site) => `site:${site}`);
  return `${query} ${terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`}`;
}

export type WebSearchOutcome = {
  provider: SearchProvider;
  results: SearchResult[];
  /** Set when the primary provider returned nothing useful. */
  error?: string;
  fallbackFrom?: SearchProvider;
  /** Search cannot work right now (a bot check, a refused key): rewording will not help. */
  blocked?: boolean;
};

/** How long search stays off for an account after the free fallback was blocked. */
export const SEARCH_BLOCKED_MS = 15 * 60 * 1000;
/** How long after a keyed provider refused the request (bad key, no credit, rate limit). */
export const SEARCH_REFUSED_MS = 5 * 60 * 1000;

/**
 * Accounts whose search is known to be down, and until when.
 * Why: a blocked search used to look like "no results", so every worker,
 * on every step, reworded the query, then tried other engines by hand, each
 * try a full model step. Remembering the outage makes the next call free.
 */
const outages = new Map<string, { until: number; reason: string }>();

/** The account's search outage, if one is in force. */
export function searchOutage(accountId: string, now = Date.now()): { until: number; reason: string } | null {
  const outage = outages.get(accountId);
  if (!outage) return null;
  if (outage.until <= now) {
    outages.delete(accountId);
    return null;
  }
  return outage;
}

export function noteSearchOutage(accountId: string, reason: string, forMs: number, now = Date.now()): void {
  outages.set(accountId, { until: now + forMs, reason });
}

/** Clears an outage (a key was added, or a search worked). */
export function clearSearchOutage(accountId: string): void {
  outages.delete(accountId);
}

/** True when DuckDuckGo answered with its bot check instead of results. */
export function isDuckBotCheck(html: string): boolean {
  return /anomaly-modal|anomaly\.js|challenge-form|Unfortunately, bots use DuckDuckGo too/i.test(html);
}

const MAX_RESULTS = 10;
const SEARCH_TIMEOUT = 20;

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const EXA_URL = "https://api.exa.ai/search";
const DUCK_URL = "https://lite.duckduckgo.com/lite/";

/**
 * Picks the search provider by key availability.
 * Why: Exa first — built for LLM agents (semantic + optional page text).
 * Brave second for classic web index; DuckDuckGo needs no key.
 */
export function selectSearchProvider(keys: { braveKey?: string | null; exaKey?: string | null }): SearchProvider {
  if (keys.exaKey) return "exa";
  if (keys.braveKey) return "brave";
  return "duckduckgo";
}

/** Alternate keyed provider when the primary returns zero rows. */
function alternateKeyedProvider(
  primary: SearchProvider,
  keys: { braveKey?: string | null; exaKey?: string | null },
): SearchProvider | null {
  if (primary === "exa" && keys.braveKey) return "brave";
  if (primary === "brave" && keys.exaKey) return "exa";
  return null;
}

export async function webSearch(
  accountId: string,
  profile: string,
  query: string,
  input: { numResults?: number; braveKey?: string | null; exaKey?: string | null; filters?: SearchFilters } = {},
): Promise<WebSearchOutcome> {
  const clean = query.trim().slice(0, 500);
  if (!clean) throw new Error("A search query is required.");
  const count = Math.min(Math.max(input.numResults ?? 8, 1), MAX_RESULTS);
  const primary = selectSearchProvider(input);
  const outage = searchOutage(accountId);
  if (outage) return { provider: primary, results: [], error: outage.reason, blocked: true };
  const first = await runProvider(accountId, profile, primary, clean, count, input);
  if (first.results.length > 0) {
    clearSearchOutage(accountId);
    return first;
  }

  const alternate = alternateKeyedProvider(primary, input);
  if (alternate) {
    const second = await runProvider(accountId, profile, alternate, clean, count, input);
    if (second.results.length > 0) {
      return { ...second, fallbackFrom: primary, error: first.error };
    }
  }

  if (primary !== "duckduckgo") {
    const ddg = await runProvider(accountId, profile, "duckduckgo", clean, count, input);
    if (ddg.results.length > 0) {
      return { ...ddg, fallbackFrom: primary, error: first.error };
    }
    // The key was refused and the free fallback gave nothing: rewording will not help for a while.
    if (first.error) {
      const reason = `the ${primary} search key was refused (${first.error})${ddg.blocked ? " and the free fallback is blocked by a bot check" : ""}`;
      noteSearchOutage(accountId, reason, SEARCH_REFUSED_MS);
      return { ...first, error: reason, blocked: true };
    }
  }
  if (first.blocked) {
    const reason = "no search key is set on this server, and the free fallback (DuckDuckGo) answers automated searches with a bot check";
    noteSearchOutage(accountId, reason, SEARCH_BLOCKED_MS);
    return { ...first, error: reason };
  }

  return first;
}

async function runProvider(
  accountId: string,
  profile: string,
  provider: SearchProvider,
  query: string,
  count: number,
  input: { braveKey?: string | null; exaKey?: string | null; filters?: SearchFilters },
): Promise<WebSearchOutcome> {
  const filters = input.filters ?? {};
  if (provider === "brave") {
    const freshness = filters.sinceDays ? `&freshness=${braveFreshness(filters.sinceDays)}` : "";
    const raw = await keyedRequest(`${BRAVE_URL}?q=${encodeURIComponent(withSites(query, filters.sites))}&count=${count}${freshness}`, {
      headers: { "X-Subscription-Token": input.braveKey ?? "" },
    });
    const error = parseApiError(raw);
    return { provider, results: parseBraveResponse(raw).slice(0, count), error };
  }
  if (provider === "exa") {
    const raw = await keyedRequest(EXA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": input.exaKey ?? "" },
      body: JSON.stringify({
        query,
        numResults: count,
        type: "auto",
        livecrawl: "fallback",
        ...(filters.sinceDays ? { startPublishedDate: new Date(Date.now() - filters.sinceDays * 86_400_000).toISOString() } : {}),
        ...(filters.sites && filters.sites.length > 0 ? { includeDomains: filters.sites } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        contents: {
          text: { maxCharacters: 2_500 },
          summary: { query },
          highlights: { maxCharacters: 1_000, query },
        },
      }),
    });
    const error = parseApiError(raw);
    return { provider, results: parseExaResponse(raw).slice(0, count), error };
  }
  const raw = await curlGet(accountId, profile, `${DUCK_URL}?q=${encodeURIComponent(withSites(query, filters.sites))}`);
  const results = parseDuckLite(raw).slice(0, count);
  if (results.length === 0 && isDuckBotCheck(raw)) {
    return { provider, results, error: "DuckDuckGo answered with a bot check", blocked: true };
  }
  return { provider, results };
}

/**
 * Fetches a keyless search page from inside the account's container.
 * Why there: the request then leaves from the account's own computer, not
 * from the core's address.
 */
async function curlGet(accountId: string, profile: string, url: string): Promise<string> {
  const args = ["curl", "-sS", "--max-time", String(SEARCH_TIMEOUT), "--max-redirs", "3", url];
  const result = await exec(accountId, args, profile);
  return result.stdout.slice(0, 200_000);
}

/**
 * Calls a search API that needs a key, from the core.
 * Why not in the container: the key may be the server's own, shared by every
 * account. A command line inside a container is readable by every agent
 * there, so the key must never appear in one. The address is one of the
 * fixed provider addresses above, never one a person supplied.
 * Input: the provider URL and the request. Output: the response text, or
 * error JSON that parseApiError reads when the provider could not be reached.
 */
async function keyedRequest(url: string, init: RequestInit): Promise<string> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT * 1000) });
    return (await response.text()).slice(0, 200_000);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "The search provider did not answer." });
  }
}

/** Surfaces provider error JSON instead of silent empty lists. */
export function parseApiError(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed) as { error?: string; message?: string; detail?: string };
    const msg = data.error ?? data.message ?? data.detail;
    return typeof msg === "string" && msg.length > 0 ? msg.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export function parseBraveResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as { web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] } };
    return (data.web?.results ?? [])
      .map((row) => ({
        title: String(row.title ?? "Untitled").slice(0, 200),
        url: String(row.url ?? ""),
        snippet: String(row.description ?? "").slice(0, 500),
        ...(typeof row.age === "string" && row.age ? { date: row.age.slice(0, 40) } : {}),
      }))
      .filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

export function parseExaResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as {
      results?: {
        title?: string;
        url?: string;
        text?: string;
        highlights?: string[];
        summary?: string;
        publishedDate?: string;
      }[];
    };
    return (data.results ?? [])
      .map((row) => {
        // Combine all evidence fields instead of first-nonempty: text carries
        // the page body, summary carries Exa's query-focused abstract, and
        // highlights carry the matched passages. One field alone is what made
        // snippets too thin to answer from.
        const parts = [
          typeof row.summary === "string" ? row.summary.trim() : "",
          Array.isArray(row.highlights) ? row.highlights.join(" ").trim() : "",
          typeof row.text === "string" ? row.text.trim() : "",
        ].filter((part) => part.length > 0);
        const seen = new Set<string>();
        const snippet = parts
          .filter((part) => {
            const key = part.slice(0, 80).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .join("\n")
          .slice(0, 1_500);
        return {
          title: String(row.title ?? "Untitled").slice(0, 200),
          url: String(row.url ?? ""),
          snippet,
          ...(typeof row.publishedDate === "string" && row.publishedDate ? { date: row.publishedDate.slice(0, 10) } : {}),
        };
      })
      .filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

export function parseDuckLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  const snippetPattern = /class=["']result-snippet["'][^>]*>(.*?)<\/td>/gis;
  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null && links.length < MAX_RESULTS) {
    const href = match[1] ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const url = uddg?.[1] ? decodeURIComponent(uddg[1]) : href;
    if (!url.startsWith("http")) continue;
    const title = (match[2] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 200) || "Untitled";
    links.push({ url, title });
  }
  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null && snippets.length < MAX_RESULTS) {
    snippets.push((match[1] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 500));
  }
  links.forEach((link, index) => {
    out.push({ title: link.title, url: link.url, snippet: snippets[index] ?? "" });
  });
  return out;
}
