import { describe, expect, it } from "vitest";
import {
  gatewayLookupKeys,
  lookupContextWindowInIndex,
  stripModelVersionSuffix,
} from "./gateway-models.js";

describe("gateway model lookup", () => {
  const index = new Map<string, number>([
    ["openai/gpt-4o", 128_000],
    ["anthropic/claude-sonnet-4", 1_000_000],
    ["nvidia/nemotron-3-nano-30b-a3b", 262_144],
  ]);

  it("strips dated Anthropic suffixes", () => {
    expect(stripModelVersionSuffix("claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
  });

  it("builds lookup keys for standard providers", () => {
    expect(gatewayLookupKeys("anthropic", "claude-sonnet-4-20250514")).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("resolves dated ids via catalog basename", () => {
    expect(lookupContextWindowInIndex(index, "anthropic", "claude-sonnet-4-20250514")).toBe(1_000_000);
  });

  it("resolves slash model ids for local-compatible routes", () => {
    expect(lookupContextWindowInIndex(index, "local", "nvidia/nemotron-3-nano-30b-a3b")).toBe(262_144);
  });

  it("resolves openai ids with or without prefix", () => {
    expect(lookupContextWindowInIndex(index, "openai", "gpt-4o")).toBe(128_000);
    expect(lookupContextWindowInIndex(index, "openai", "openai/gpt-4o")).toBe(128_000);
  });

  it("finds a model whose id was typed in another case, with or without its vendor", () => {
    const index = new Map([["xiaomi/mimo-v2.6-flash", 1_048_576]]);
    expect(lookupContextWindowInIndex(index, "local", "MiMo-V2.6-Flash")).toBe(1_048_576);
    expect(lookupContextWindowInIndex(index, "local", "Xiaomi/MiMo-V2.6-Flash")).toBe(1_048_576);
  });
});
