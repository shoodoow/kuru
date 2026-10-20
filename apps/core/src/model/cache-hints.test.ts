import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { cachedSystem, openAiCacheOptions, promptCacheKey, stepMessages, withCacheMark } from "./cache-hints.js";

type Marked = { providerOptions?: { anthropic?: { cacheControl?: unknown } } };

describe("withCacheMark", () => {
  it("marks only the newest message for Anthropic's cache", () => {
    const marked = withCacheMark([
      { role: "user", content: "brief" },
      { role: "user", content: "old", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "user", content: "new" },
    ] as ModelMessage[]) as Marked[];
    expect(marked[0]!.providerOptions).toBeUndefined();
    expect(marked[1]!.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    expect(marked[2]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("leaves an empty conversation empty", () => {
    expect(withCacheMark([])).toEqual([]);
  });
});

describe("stepMessages", () => {
  const messages = [{ role: "user", content: "a" }, { role: "user", content: "b" }] as ModelMessage[];

  it("marks the newest message for Anthropic", () => {
    const out = stepMessages("anthropic", messages) as Marked[];
    expect(out[1]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("returns the same array for other providers", () => {
    expect(stepMessages("openai", messages)).toBe(messages);
  });
});

describe("cachedSystem", () => {
  it("marks the system text for Anthropic only", () => {
    expect(cachedSystem("anthropic", "rules").providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(cachedSystem("openai", "rules")).toEqual({ role: "system", content: "rules" });
  });
});

describe("promptCacheKey", () => {
  it("joins short parts as they are", () => {
    expect(promptCacheKey("account-1", "agent-1", 3)).toBe("account-1:agent-1:3");
  });

  it("hashes a key longer than OpenAI allows", () => {
    const key = promptCacheKey("8f14e45f-ceea-467a-9575-0d1a2b3c4d5e", "c9f0f895-fb98-4b3c-8c1e-6a7b8c9d0e1f");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });
});

describe("openAiCacheOptions", () => {
  it("is set only for the official OpenAI endpoint", () => {
    expect(openAiCacheOptions("openai", null, "k")).toEqual({ openai: { promptCacheKey: "k", promptCacheRetention: "24h" } });
    expect(openAiCacheOptions("openai", "https://openrouter.ai/api/v1", "k")).toBeUndefined();
    expect(openAiCacheOptions("anthropic", null, "k")).toBeUndefined();
  });
});
