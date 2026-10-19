import { describe, expect, it } from "vitest";
import { cheapestProviderFetch, getModel, isOpenRouter } from "./get-model.js";

describe("getModel", () => {
  it("rejects a provider that has no SDK package", () => {
    expect(() => getModel("other", "m")).toThrow(/provider/);
  });

  it("accepts openai with a custom compatible base URL", () => {
    expect(() =>
      getModel("openai", "nvidia/nemotron-3-super-120b-a12b", "nvapi-test", "https://integrate.api.nvidia.com/v1"),
    ).not.toThrow();
  });
});

describe("OpenRouter routing", () => {
  const sent = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let seen = "";
    const fake = (async (_url: unknown, init?: RequestInit) => {
      seen = String(init?.body ?? "");
      return new Response("{}");
    }) as typeof fetch;
    await cheapestProviderFetch(fake)("https://openrouter.ai/api/v1/responses", { method: "POST", body: JSON.stringify(body) });
    return JSON.parse(seen) as Record<string, unknown>;
  };

  it("asks for the cheapest provider", async () => {
    expect((await sent({ model: "deepseek/deepseek-v4.1-flash", input: "hi" })).provider).toEqual({ sort: "price" });
  });

  it("leaves a request alone that routes itself", async () => {
    expect((await sent({ model: "deepseek/deepseek-v4.1-flash:nitro" })).provider).toBeUndefined();
    expect((await sent({ model: "x/y", provider: { order: ["DeepInfra"] } })).provider).toEqual({ order: ["DeepInfra"] });
  });

  it("knows OpenRouter by its address", () => {
    expect(isOpenRouter("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouter("https://integrate.api.nvidia.com/v1")).toBe(false);
    expect(isOpenRouter(null)).toBe(false);
  });
});
