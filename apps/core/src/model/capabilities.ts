/**
 * What a model can do: see pictures, and how long one answer may be.
 * Why: workers sent screenshots to a model that reads only text. The
 * provider refused the whole request, the job failed, and the agent started
 * it again, paying for every step a second time. Requests also went out with
 * no output limit, so the provider reserved credit for 65,536 tokens on every
 * step and refused work it could easily afford.
 * Sources, first that knows wins: what a provider told us at run time, the
 * OpenRouter catalog (its ids are the ones the `local` provider uses), the
 * AI Gateway catalog, then estimates for the big providers. Unknown stays
 * null: callers decide what unknown means for them.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Dollars per token, as the provider lists them. */
export type ModelPricing = { input: number; output: number; cacheRead: number | null };

export type ModelCapabilities = {
  /** True when the model accepts images, false when it does not, null when unknown. */
  vision: boolean | null;
  /** The longest answer the model can give, in tokens, when known. */
  maxOutputTokens: number | null;
  /** List prices, when known: what the usage page and the daily limit count in dollars. */
  pricing?: ModelPricing | null;
};

type CatalogRow = { vision: boolean | null; maxOutputTokens: number | null; pricing?: ModelPricing | null };

let openRouter: Map<string, CatalogRow> | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
/** What providers told us while running: "this model takes no images". Beats every catalog. */
const learned = new Map<string, Partial<CatalogRow>>();

function key(provider: string, modelId: string): string {
  return `${provider}:${modelId.trim().toLowerCase()}`;
}

/** Parses the OpenRouter models list into id → capabilities. */
export function parseOpenRouterCatalog(body: unknown): Map<string, CatalogRow> {
  const index = new Map<string, CatalogRow>();
  const rows = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows)) return index;
  for (const raw of rows) {
    const row = raw as {
      id?: string;
      architecture?: { input_modalities?: string[] };
      top_provider?: { max_completion_tokens?: number | null };
      pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
    };
    if (!row.id) continue;
    const modalities = row.architecture?.input_modalities;
    const max = row.top_provider?.max_completion_tokens;
    const price = (value?: string) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const input = price(row.pricing?.prompt);
    const output = price(row.pricing?.completion);
    index.set(row.id.toLowerCase(), {
      vision: Array.isArray(modalities) ? modalities.includes("image") : null,
      maxOutputTokens: typeof max === "number" && max > 0 ? Math.floor(max) : null,
      pricing: input !== null && output !== null ? { input, output, cacheRead: price(row.pricing?.input_cache_read) } : null,
    });
  }
  return index;
}

async function refreshOpenRouter(): Promise<void> {
  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenRouter models list failed (${response.status}).`);
  openRouter = parseOpenRouterCatalog(await response.json());
  loadedAt = Date.now();
}

async function ensureCatalog(): Promise<void> {
  if (openRouter && Date.now() - loadedAt < CACHE_TTL_MS) return;
  inflight ??= refreshOpenRouter()
    .catch(() => {
      // Offline or refused: keep the last list, and do not ask again for a while.
      loadedAt = Date.now();
      openRouter ??= new Map();
    })
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

/** Ids the OpenRouter catalog may list this model under. */
export function openRouterKeys(provider: string, modelId: string): string[] {
  const id = modelId.trim().toLowerCase();
  const keys = [id, id.replace(/:[a-z-]+$/, "")];
  if (!id.includes("/") && (provider === "anthropic" || provider === "openai" || provider === "xai")) {
    const owner = provider === "xai" ? "x-ai" : provider;
    const stripped = id.replace(/(-\d{8}|-\d{4}-\d{2}-\d{2})$/, "");
    keys.push(`${owner}/${stripped}`);
    // Anthropic ids use dashes where OpenRouter uses a dot: claude-haiku-5-5 → claude-haiku-5.5.
    keys.push(`${owner}/${stripped.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`);
  }
  return [...new Set(keys)];
}

/** Estimates for providers whose current models all take pictures. */
function builtin(provider: string): CatalogRow | null {
  if (provider === "anthropic" || provider === "openai" || provider === "xai") return { vision: true, maxOutputTokens: null };
  return null;
}

/** Looks a model up without loading anything; the catalog may not be there yet. */
export function capabilitiesFromIndex(
  index: ReadonlyMap<string, CatalogRow> | null,
  provider: string,
  modelId: string,
): ModelCapabilities {
  const told = learned.get(key(provider, modelId)) ?? {};
  let found: CatalogRow | null = null;
  for (const candidate of openRouterKeys(provider, modelId)) {
    const hit = index?.get(candidate);
    if (hit) {
      found = hit;
      break;
    }
  }
  found ??= builtin(provider);
  return {
    vision: told.vision ?? found?.vision ?? null,
    maxOutputTokens: told.maxOutputTokens ?? found?.maxOutputTokens ?? null,
    pricing: found?.pricing ?? null,
  };
}

/**
 * Estimated dollars for some usage of one model, or null when its prices are unknown.
 * Input tokens include the cached part, which is billed at the cache price when listed.
 */
export function estimateCost(
  pricing: ModelPricing | null | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number | null },
): number | null {
  if (!pricing) return null;
  const cached = Math.min(usage.cacheReadTokens ?? 0, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return fresh * pricing.input + cached * (pricing.cacheRead ?? pricing.input) + usage.outputTokens * pricing.output;
}

export async function modelCapabilities(provider: string, modelId: string): Promise<ModelCapabilities> {
  await ensureCatalog();
  return capabilitiesFromIndex(openRouter, provider, modelId);
}

/** Records what a provider said at run time, e.g. that a model refused an image. */
export function learnCapability(provider: string, modelId: string, fact: Partial<CatalogRow>): void {
  const current = learned.get(key(provider, modelId)) ?? {};
  learned.set(key(provider, modelId), { ...current, ...fact });
}

/** True when a provider error means the model cannot take the pictures it was sent. */
export function isNoImageInputError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { responseBody?: unknown }).responseBody ?? "")}` : String(error);
  return /support image input|image input is not supported|does not support image|image_url is only supported|not a multimodal|vision is not supported/i.test(text);
}

/** For tests: replace the catalog and forget what was learned. */
export function __setCapabilitiesForTests(index: Map<string, CatalogRow> | null): void {
  openRouter = index;
  loadedAt = index ? Date.now() : 0;
  learned.clear();
}
