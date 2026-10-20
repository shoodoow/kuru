/**
 * Provider prompt-cache hints, in one place.
 * Why: every model step resends the whole conversation. With the right hints the
 * provider reads everything it has seen before from its cache at about a tenth
 * of the price. These hints were copied into the chat loop and the worker loop
 * separately, and each loop ended up missing one: the chat loop never marked its
 * messages for Anthropic, and the worker never sent OpenAI its cache key.
 * DB: none.
 */
import { createHash } from "node:crypto";
import type { ModelMessage, SystemModelMessage } from "ai";
import { usesOfficialOpenAiEndpoint } from "./get-model.js";

const EPHEMERAL = { cacheControl: { type: "ephemeral" } } as const;
/** Longest prompt cache key OpenAI accepts. */
const CACHE_KEY_MAX = 64;

/**
 * A system message, cache-marked for Anthropic.
 * Input: provider and the system text. Output: the message for `instructions`.
 */
export function cachedSystem(provider: string, content: string): SystemModelMessage {
  return provider === "anthropic"
    ? { role: "system", content, providerOptions: { anthropic: EPHEMERAL } }
    : { role: "system", content };
}

/**
 * The conversation with a cache mark on its newest message (Anthropic).
 * Why: Anthropic caches a prompt only up to a marked point. Without a mark on
 * the messages, every step paid full price for the whole conversation.
 * Only the newest message is marked; earlier marks are taken off, since a
 * request may carry only four.
 */
export function withCacheMark(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message, index) => {
    const options = (message as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions;
    if (index === messages.length - 1) {
      return { ...message, providerOptions: { ...options, anthropic: { ...options?.anthropic, ...EPHEMERAL } } } as ModelMessage;
    }
    if (!options?.anthropic?.cacheControl) return message;
    const { cacheControl: _dropped, ...rest } = options.anthropic;
    return { ...message, providerOptions: { ...options, anthropic: rest } } as ModelMessage;
  });
}

/** The messages one step sends: cache-marked for Anthropic, unchanged for everyone else. */
export function stepMessages(provider: string, messages: ModelMessage[]): ModelMessage[] {
  return provider === "anthropic" ? withCacheMark(messages) : messages;
}

/**
 * A stable prompt cache key from its parts, hashed when longer than OpenAI allows.
 * Input: parts such as account id and agent id. Output: at most 64 characters.
 */
export function promptCacheKey(...parts: (string | number)[]): string {
  const raw = parts.join(":");
  return raw.length <= CACHE_KEY_MAX ? raw : createHash("sha256").update(raw).digest("hex");
}

/**
 * `providerOptions` that route repeat requests to OpenAI's cache, or undefined elsewhere.
 * Input: provider, the key's base URL (a custom one is not OpenAI), and the cache key.
 */
export function openAiCacheOptions(
  provider: string,
  baseUrl: string | null | undefined,
  cacheKey: string,
): { openai: { promptCacheKey: string; promptCacheRetention: "24h" } } | undefined {
  return usesOfficialOpenAiEndpoint(provider, baseUrl)
    ? { openai: { promptCacheKey: cacheKey, promptCacheRetention: "24h" } }
    : undefined;
}
