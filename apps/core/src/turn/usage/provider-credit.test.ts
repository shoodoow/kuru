import { describe, expect, it } from "vitest";
import { billedBy, deepSeekCredit, openRouterCredit } from "./provider-credit.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("provider credit", () => {
  it("reads an OpenRouter key's limit and use, and says when the balance needs a management key", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith("/key")
        ? reply(200, { data: { limit: 50, limit_remaining: 2.1, usage_daily: 31.4, usage_monthly: 47.9 } })
        : reply(403, { error: { message: "Only management keys can perform this operation" } })) as unknown as typeof fetch;
    const credit = await openRouterCredit("local", "sk-or-test", fetchImpl);
    expect(credit).toMatchObject({ service: "OpenRouter", keyLimitUsd: 50, keyRemainingUsd: 2.1, usedTodayUsd: 31.4, usedMonthUsd: 47.9, balanceUsd: null });
  });

  it("reads the account balance when the key may", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith("/key") ? reply(200, { data: { limit: null, limit_remaining: null } }) : reply(200, { data: { total_credits: 100.5, total_usage: 25.75 } })) as unknown as typeof fetch;
    expect((await openRouterCredit("local", "k", fetchImpl)).balanceUsd).toBeCloseTo(74.75, 6);
  });

  it("reads DeepSeek's balance", async () => {
    const fetchImpl = (async () => reply(200, { balance_infos: [{ currency: "USD", total_balance: "12.40" }] })) as unknown as typeof fetch;
    expect((await deepSeekCredit("local", "k", fetchImpl)).balanceUsd).toBe(12.4);
  });

  it("knows who bills a provider from its address", () => {
    expect(billedBy("local", "https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(billedBy("openai", "https://api.deepseek.com/v1")).toBe("deepseek");
    expect(billedBy("anthropic", null)).toBe("anthropic");
    expect(billedBy("openai", "https://integrate.api.nvidia.com/v1")).toBe("other");
  });
});
