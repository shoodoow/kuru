/**
 * Vercel AI Gateway model catalog (GET https://ai-gateway.vercel.sh/v1/models).
 * Why: provider APIs do not expose a single context-window lookup for arbitrary
 * model ids (dated Anthropic ids, NVIDIA via OpenAI-compatible routes, etc.).
 * The gateway list includes context_window per model and is unauthenticated.
 */

import { registerModelInfoProvider } from "../turn/usage/model-info.js";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;

type GatewayModelRow = {
  id: string;
  context_window?: number;
};

let indexById: Map<string, number> | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Maps our provider enum to gateway `owned_by` / id prefix. */
function gatewayOwnerForProvider(provider: string): string | null {
  if (provider === "openai" || provider === "anthropic" || provider === "xai") return provider;
  return null;
}

/** Strips trailing API version dates so `claude-sonnet-4-20250514` matches catalog basenames. */
export function stripModelVersionSuffix(modelId: string): string {
  return modelId.replace(/(-\d{8}|-\d{4}-\d{2}-\d{2})$/, "");
}

/** Candidate gateway ids to try for one provider + model id pair. */
export function gatewayLookupKeys(provider: string, modelId: string): string[] {
  const trimmed = modelId.trim();
  const keys: string[] = [];
  if (trimmed.includes("/")) keys.push(trimmed);
  const owner = gatewayOwnerForProvider(provider);
  if (owner) {
    keys.push(`${owner}/${trimmed}`);
    const stripped = stripModelVersionSuffix(trimmed);
    if (stripped !== trimmed) keys.push(`${owner}/${stripped}`);
  }
  return [...new Set(keys)];
}

export function lookupContextWindowInIndex(
  index: Map<string, number>,
  provider: string,
  modelId: string,
): number | null {
  for (const key of gatewayLookupKeys(provider, modelId)) {
    const hit = index.get(key);
    if (typeof hit === "number" && hit > 0) return Math.floor(hit);
  }
  // Providers accept an id in any case ("MiMo-V2.6-Flash"); the catalog lists
  // it in lower case. Without this the window was unknown and the ring stayed empty.
  const trimmed = modelId.trim().toLowerCase();
  const stripped = stripModelVersionSuffix(trimmed);
  const owner = gatewayOwnerForProvider(provider);
  for (const [listed, contextWindow] of index) {
    if (!(contextWindow > 0)) continue;
    const id = listed.toLowerCase();
    if (id === trimmed) return Math.floor(contextWindow);
    const slash = id.indexOf("/");
    if (slash < 0) continue;
    const idOwner = id.slice(0, slash);
    const basename = id.slice(slash + 1);
    if (owner && idOwner !== owner) continue;
    if (
      basename === stripped ||
      basename === trimmed ||
      stripped.startsWith(`${basename}-`) ||
      trimmed.startsWith(`${basename}-`)
    ) {
      return Math.floor(contextWindow);
    }
  }
  return null;
}

function buildIndex(rows: GatewayModelRow[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of rows) {
    const window = row.context_window;
    if (typeof window === "number" && window > 0 && row.id) {
      index.set(row.id, window);
    }
  }
  return index;
}

async function refreshGatewayIndex(): Promise<void> {
  const response = await fetch(GATEWAY_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`AI Gateway models list failed (${response.status}).`);
  }
  const body = (await response.json()) as { data?: GatewayModelRow[] };
  indexById = buildIndex(body.data ?? []);
  loadedAt = Date.now();
}

export async function ensureGatewayModelsLoaded(force = false): Promise<void> {
  const stale = !indexById || Date.now() - loadedAt > CACHE_TTL_MS;
  if (!force && !stale && indexById) return;
  if (inflight) {
    await inflight;
    return;
  }
  inflight = refreshGatewayIndex()
    .catch((error) => {
      if (!indexById) throw error;
    })
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

export async function resolveGatewayContextWindow(provider: string, modelId: string): Promise<number | null> {
  await ensureGatewayModelsLoaded();
  if (!indexById) return null;
  return lookupContextWindowInIndex(indexById, provider, modelId);
}

export function registerGatewayModelInfoProvider(): void {
  registerModelInfoProvider({
    name: "vercel-ai-gateway",
    contextWindowFor(provider, modelId) {
      if (!indexById) return null;
      return lookupContextWindowInIndex(indexById, provider, modelId);
    },
  });
}

/** For tests: inject a catalog without hitting the network. */
export function __setGatewayModelIndexForTests(index: Map<string, number> | null): void {
  indexById = index;
  loadedAt = index ? Date.now() : 0;
}
