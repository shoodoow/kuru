import { afterEach, describe, expect, it } from "vitest";
import {
  __setCapabilitiesForTests,
  capabilitiesFromIndex,
  isNoImageInputError,
  learnCapability,
  openRouterKeys,
  parseOpenRouterCatalog,
} from "./capabilities.js";
import { picturesAsNotes } from "../turn/prompt-media.js";

const catalog = parseOpenRouterCatalog({
  data: [
    { id: "inclusionai/ling-3.1-flash", architecture: { input_modalities: ["text"] }, top_provider: { max_completion_tokens: 235929 } },
    { id: "z-ai/glm-5.3-flash", architecture: { input_modalities: ["text", "image", "video"] }, top_provider: { max_completion_tokens: 943718 } },
    { id: "anthropic/claude-haiku-5.5", architecture: { input_modalities: ["text", "image"] }, top_provider: { max_completion_tokens: 128000 } },
  ],
});

describe("model capabilities", () => {
  afterEach(() => __setCapabilitiesForTests(null));

  it("knows from the catalog which models see pictures and how long they may answer", () => {
    expect(capabilitiesFromIndex(catalog, "local", "inclusionai/ling-3.1-flash")).toMatchObject({ vision: false, maxOutputTokens: 235929 });
    expect(capabilitiesFromIndex(catalog, "local", "z-ai/glm-5.3-flash").vision).toBe(true);
    // Anthropic's own ids map onto the catalog's dotted ones.
    expect(openRouterKeys("anthropic", "claude-haiku-5-5")).toContain("anthropic/claude-haiku-5.5");
    expect(capabilitiesFromIndex(catalog, "anthropic", "claude-haiku-5-5").maxOutputTokens).toBe(128000);
    // Unknown stays unknown.
    expect(capabilitiesFromIndex(catalog, "local", "some/new-model")).toEqual({ vision: null, maxOutputTokens: null, pricing: null });
  });

  it("prices usage with the cache read price for the cached part", async () => {
    const { estimateCost } = await import("./capabilities.js");
    const priced = parseOpenRouterCatalog({
      data: [{ id: "a/b", pricing: { prompt: "0.000001", completion: "0.000004", input_cache_read: "0.0000001" } }],
    });
    const pricing = capabilitiesFromIndex(priced, "local", "a/b").pricing;
    // 1M input of which 900K cached, 10K output: 100K × $1/M + 900K × $0.1/M + 10K × $4/M = $0.23.
    expect(estimateCost(pricing, { inputTokens: 1_000_000, cacheReadTokens: 900_000, outputTokens: 10_000 })).toBeCloseTo(0.23, 6);
    expect(estimateCost(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("lets what a provider said at run time win over the catalog", () => {
    learnCapability("local", "z-ai/glm-5.3-flash", { vision: false });
    expect(capabilitiesFromIndex(catalog, "local", "z-ai/glm-5.3-flash").vision).toBe(false);
  });

  it("recognises a provider refusing pictures", () => {
    expect(isNoImageInputError(new Error("No endpoints found that support image input"))).toBe(true);
    expect(isNoImageInputError(new Error("Invalid API key"))).toBe(false);
  });

  it("replaces pictures in a chat prompt with a note and leaves text alone", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: "https://x/y.png" }] },
      { role: "user", content: "plain" },
    ];
    const out = picturesAsNotes(messages) as { content: unknown }[];
    expect(JSON.stringify(out[0]!.content)).not.toContain("https://x/y.png");
    expect(JSON.stringify(out[0]!.content)).toContain("cannot see pictures");
    expect(out[1]).toBe(messages[1]);
  });
});

describe("pictures for a worker that cannot see", () => {
  it("are described by another model, or explained, never sent raw", async () => {
    const { pictureAsText } = await import("../turn/tools/build-tools.js");
    const shot = { path: "/home/u/frame.png", pngBase64: "AAAA" };
    const seen: string[] = [];
    const describe = async (image: { path: string; mediaType: string }) => {
      seen.push(image.mediaType);
      return `Image ${image.path}: a blank frame.`;
    };
    expect(await pictureAsText(shot, { canSee: () => false, describe })).toBe("Image /home/u/frame.png: a blank frame.");
    expect(seen).toEqual(["image/png"]);
    expect(await pictureAsText(shot, { canSee: () => false, describe: null })).toMatch(/cannot see pictures/);
    // A model that can see gets the picture as it is.
    expect(await pictureAsText(shot, { canSee: () => true, describe })).toBe(shot);
    expect(await pictureAsText("plain text", { canSee: () => false, describe })).toBe("plain text");
  });
});
