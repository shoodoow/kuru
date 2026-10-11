/**
 * Checks a provider key or address before it is saved, by asking the provider
 * for its list of models.
 * Why: a wrong key or a mistyped address used to be saved as it was. The
 * person found out later, as an agent that never answered. Asking for the
 * model list costs nothing, proves the key and the address, and returns the
 * model ids, which the default-model check then uses.
 */

type FetchImpl = typeof fetch;

export type ProviderCheck =
  /** The provider answered: the key and address are good. */
  | { ok: true; models: string[] }
  /** The provider could not be asked for its models, so nothing is known either way. */
  | { ok: null; note: string }
  /** The key was refused or nothing answered at the address. */
  | { ok: false; error: string };

/** Raised by the save when the check fails; the phone shows the message. */
export class ProviderCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCheckError";
  }
}

const TIMEOUT_MS = 10_000;

const OFFICIAL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Asks the provider for its models.
 * Input: the provider name, the key, and the address for a local or custom
 * OpenAI-compatible server. Output: the outcome, in words a person can act on.
 */
export async function checkProvider(
  provider: string,
  apiKey: string,
  baseUrl?: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<ProviderCheck> {
  const custom = baseUrl?.trim().replace(/\/+$/, "");
  const base = (provider === "openai" || provider === "local") && custom ? custom : OFFICIAL[provider];
  if (!base) return { ok: false, error: provider === "local" ? "A local provider needs its address." : `Unknown provider ${provider}.` };
  const key = apiKey.trim();
  const headers: Record<string, string> =
    provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : key ? { authorization: `Bearer ${key}` } : {};
  const address = `${base}/models`;
  const host = new URL(base).host;
  let response: Response;
  try {
    response = await fetchImpl(address, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const slow = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      error: slow
        ? `${host} did not answer within ${TIMEOUT_MS / 1000} seconds. Check the address.`
        : custom
          ? `Nothing answered at ${base}. Check the address, and that the server can be reached from where this app's server runs (an address like localhost means that machine, not your phone).`
          : `Could not reach ${host}. Try again in a moment.`,
    };
  }
  // Some providers answer a bad key with a plain 400 that says so in words.
  const complaint = response.status === 400 ? await response.clone().text().catch(() => "") : "";
  if (response.status === 401 || response.status === 403 || /api.?key|unauthori[sz]ed|authenticat/i.test(complaint)) {
    return { ok: false, error: key ? `${host} refused that key. Check you copied all of it and that it is still active.` : `${host} needs an API key.` };
  }
  if (response.status === 404 || response.status === 405) {
    // The usual slip is leaving /v1 off the end. If the list is there, say so.
    if (custom && !/\/v\d+$/.test(custom)) {
      const deeper = await fetchImpl(`${custom}/v1/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
      if (deeper?.ok) return { ok: false, error: `That address is missing its last part. Use ${custom}/v1.` };
    }
    // Some OpenAI-compatible servers have no model list. The address may still be right.
    return custom
      ? { ok: null, note: `${host} has no model list at ${address}, so the address could not be checked. Most servers want it to end in /v1.` }
      : { ok: false, error: `${host} answered, but not as expected (status ${response.status}).` };
  }
  if (!response.ok) {
    return { ok: false, error: `${host} answered with an error (status ${response.status}). Try again in a moment.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return custom
      ? { ok: false, error: `Something answered at ${base}, but it is not a model API. Most servers want the address to end in /v1.` }
      : { ok: null, note: `${host} answered in a form that could not be read.` };
  }
  const rows = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models ?? body;
  const models = (Array.isArray(rows) ? rows : [])
    .map((row) => (typeof row === "string" ? row : typeof (row as { id?: unknown })?.id === "string" ? (row as { id: string }).id : ""))
    .filter(Boolean);
  if (models.length === 0 && custom) {
    return { ok: false, error: `Something answered at ${base}, but it lists no models. Most servers want the address to end in /v1.` };
  }
  // Many gateways hand their model list to anyone, so a list that came back
  // says nothing about the key. An empty chat request does: a server checks
  // who is asking before it reads the request, so a bad key is refused (401)
  // and a good one gets "your request is empty". It costs nothing either way.
  if (custom && key) {
    const probe = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (probe && (probe.status === 401 || probe.status === 403)) {
      return { ok: false, error: `${host} refused that key. Check you copied all of it and that it is still active.` };
    }
  }
  return { ok: true, models };
}

/**
 * Says whether a model id is one the provider offers.
 * Input: the id the person typed and the provider's list.
 * Output: null when it is listed (or the list is empty, so nothing is known),
 * otherwise a sentence naming close matches.
 */
export function unknownModel(modelId: string, models: string[]): string | null {
  if (models.length === 0 || models.some((id) => sameModel(modelId, id))) return null;
  const wanted = modelId.toLowerCase();
  const words = wanted.split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  const close = models
    .map((id) => ({ id, score: words.filter((word) => id.toLowerCase().includes(word)).length }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.id.length - right.id.length)
    .slice(0, 5)
    .map((row) => row.id);
  const shown = close.length > 0 ? close : models.slice(0, 5);
  return `This provider has no model called "${modelId}". ${close.length > 0 ? "Did you mean" : "It offers"}: ${shown.join(", ")}${models.length > shown.length ? ", and others" : ""}.`;
}

/**
 * True when a typed id names a listed model.
 * Providers accept more spellings than they list: another case, the name
 * without its vendor prefix ("mimo-v2.6-flash" for "xiaomi/mimo-v2.6-flash"),
 * or a short alias of a dated id ("claude-sonnet-5-5" for "claude-sonnet-5-5-20260101").
 */
function sameModel(typed: string, listed: string): boolean {
  const want = typed.toLowerCase();
  const full = listed.toLowerCase();
  const bare = full.slice(full.lastIndexOf("/") + 1);
  return [full, bare].some((id) => id === want || id.startsWith(`${want}-`) || id.startsWith(`${want}:`) || id.startsWith(`${want}@`));
}
