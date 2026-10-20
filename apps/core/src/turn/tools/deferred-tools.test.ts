import { describe, expect, it } from "vitest";
import { deferredToolsBlock, pluginToolKey } from "./tool-sets.js";

describe("deferredToolsBlock", () => {
  const gates = new Map([
    ["resend_send-email", "plugin:resend"],
    ["resend_list-emails", "plugin:resend"],
    ["browser_click", "family:browser"],
    ["browser_snapshot", "family:browser"],
  ]);
  const loaders = new Map([
    ["resend_load_tools", "plugin:resend"],
    ["load_browser_tools", "family:browser"],
  ]);

  it("lists each unloaded plugin tool by exact name with its loader, and a family as one line", () => {
    const block = deferredToolsBlock(gates, loaders, new Set());
    expect(block).toContain("<available-deferred-tools>");
    expect(block).toContain('resend: load with resend_load_tools {"tools": [exact names]}');
    expect(block).toContain("\nresend_send-email\n");
    expect(block).toContain("browser (2 tools): call load_browser_tools");
    expect(block).not.toContain("browser_click");
  });

  it("leaves out what is already loaded", () => {
    const block = deferredToolsBlock(gates, loaders, new Set(["family:browser", pluginToolKey("resend_send-email")]));
    expect(block).not.toContain("resend_send-email");
    expect(block).toContain("resend_list-emails");
    expect(block).not.toContain("browser");
    expect(deferredToolsBlock(gates, loaders, new Set(["family:browser", "plugin:resend"]))).toBe("");
  });
});

describe("deferredToolsBlock for a big plugin", () => {
  it("lists its names on one line with the shared prefix said once", () => {
    const names = Array.from({ length: 30 }, (_, index) => `resend_tool-${index}`);
    const gates = new Map(names.map((name) => [name, "plugin:resend"]));
    const loaders = new Map([["resend_load_tools", "plugin:resend"]]);
    const block = deferredToolsBlock(gates, loaders, new Set());
    expect(block).toContain("each name below starts with resend_");
    expect(block).toContain("tool-0, tool-1, tool-2");
    expect(block).not.toContain("\nresend_tool-0\n");
  });
});
