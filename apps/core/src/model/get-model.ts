import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

/** OpenAI SDK–compatible providers (custom base URL + chat/completions). */
export function isOpenAiCompatibleProvider(provider: string): boolean {
  return provider === "openai" || provider === "local";
}

/** True when calls should hit the default OpenAI API (prompt cache, etc.). */
export function usesOfficialOpenAiEndpoint(provider: string, baseUrl?: string | null): boolean {
  return provider === "openai" && !baseUrl?.trim();
}

/** True for an OpenRouter address. */
export function isOpenRouter(baseUrl?: string | null): boolean {
  return /^https?:\/\/([^/]*\.)?openrouter\.ai(\/|$)/i.test(baseUrl?.trim() ?? "");
}

/**
 * Slowest generation speed (tokens per second, median) a provider should have to be picked first.
 * Why: the cheapest provider of DeepSeek V4.1 Flash wrote 20 tokens a second;
 * one worker step of hidden thinking then took 21 to 39 minutes. Others write
 * 60 to 105. Slower providers stay as a last fallback, so nothing is blocked.
 */
export const MIN_PROVIDER_TOKENS_PER_SECOND = 50;

/**
 * A fetch that asks OpenRouter for the cheapest provider of the model that is fast enough.
 * Why: by default OpenRouter spreads requests over every provider of a model,
 * and their prices differ up to 15 times (DeepSeek V4.1 Flash: $0.04 to $0.60
 * per million input tokens). Our calls went to a provider charging 2.6 times
 * the listed input price and 6 times the cached price, so the account paid
 * about five times what Usage showed, and moving between providers also lost
 * the prompt cache, which lives with one provider. Sorting by price keeps
 * fallbacks when that provider is down. A model id with its own routing
 * suffix (`:nitro`, `:floor`) or a request that already says how to route is left alone.
 * It also keeps hidden thinking to half the output limit (withThinkingRoom).
 */
export function cheapestProviderFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const next = withThinkingRoom(withProviderRouting(body));
          if (next !== body) return fetchImpl(input, { ...init, body: JSON.stringify(next) });
        }
      } catch {
        // Not JSON: send it as it is.
      }
    }
    return fetchImpl(input, init);
  };
}

/** The request with OpenRouter routing added, unless the model id or the request already routes itself. */
function withProviderRouting(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "";
  if ("provider" in body || model.includes(":")) return body;
  return { ...body, provider: { sort: "price", preferred_min_throughput: MIN_PROVIDER_TOKENS_PER_SECOND } };
}

/**
 * The request with hidden thinking held to half its output limit, so there is always room left to act.
 * Why: a showreel worker thought through the whole 24K limit four times and did nothing
 * (21 to 39 minutes each). With half the limit for thinking the same request wrote its file.
 * Normal steps think far less (median ~140 tokens), so this only stops a runaway.
 * A request that sets its own thinking (effort or a token limit) is left alone.
 */
function withThinkingRoom(body: Record<string, unknown>): Record<string, unknown> {
  const limit = [body.max_output_tokens, body.max_tokens, body.max_completion_tokens].find((value) => typeof value === "number") as number | undefined;
  const reasoning = (body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}) as Record<string, unknown>;
  if (!limit || limit < 2_000 || "max_tokens" in reasoning || "effort" in reasoning) return body;
  return { ...body, reasoning: { ...reasoning, max_tokens: Math.floor(limit / 2) } };
}

function openAiCompatibleModel(modelId: string, apiKey: string, baseUrl?: string | null, placeholderKey = ""): LanguageModel {
  const trimmedBase = baseUrl?.trim();
  const key = apiKey.trim() || placeholderKey || undefined;
  return createOpenAI({
    ...(key ? { apiKey: key } : {}),
    ...(trimmedBase ? { baseURL: trimmedBase } : {}),
    ...(isOpenRouter(trimmedBase) ? { fetch: cheapestProviderFetch() } : {}),
  })(modelId);
}

/**
 * Returns the Vercel AI SDK model for one provider name and model id.
 * Input: provider name and model id. Output: the SDK model object used by generateText.
 * This is the only place that chooses a provider package.
 *
 * For `openai`, an optional base URL (e.g. NVIDIA `https://integrate.api.nvidia.com/v1`) uses the
 * OpenAI-compatible client with your API key and model id (e.g. `nvidia/nemotron-3-super-120b-a12b`).
 */
export function getModel(provider: string, modelId: string, apiKey = "", baseUrl?: string | null): LanguageModel {
  switch (provider) {
    case "openai":
      return openAiCompatibleModel(modelId, apiKey, baseUrl);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "xai":
      return createXai({ apiKey })(modelId);
    case "local":
      return openAiCompatibleModel(modelId, apiKey, baseUrl, "local");
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
}
