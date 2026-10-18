import { describe, expect, it } from "vitest";
import { tool, jsonSchema, type ToolSet } from "ai";
import { familyOf, gateToolFamilies, startNamedPlugins, startingFamilies } from "./worker-tool-families.js";
import { activeWorkerTools } from "../turn/tools/tool-sets.js";
import { mentionedToUse } from "../turn/tools/mentions.js";
import type { ToolContext } from "../turn/tools/context.js";

const stub = () => tool({ description: "x", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "ok" });

function workerTools(): ToolSet {
  const names = ["bash", "read", "write", "wait", "web_search", "computer_memory", "browser_click", "browser_snapshot", "computer_click", "open_on_screen"];
  return Object.fromEntries(names.map((name) => [name, stub()])) as ToolSet;
}

const context = () => ({ enabledToolSets: new Set<string>(), pluginGates: new Map<string, string>(), pluginLoaders: new Map<string, string>() }) as ToolContext;

const active = (tools: ToolSet, ctx: ToolContext) =>
  activeWorkerTools(Object.keys(tools), ctx.enabledToolSets!, { gates: ctx.pluginGates, loaders: ctx.pluginLoaders });

describe("worker tool families", () => {
  it("keeps memory with every worker and sorts screen tools into families", () => {
    expect(familyOf("computer_memory")).toBeNull();
    expect(familyOf("bash")).toBeNull();
    expect(familyOf("browser_click")).toBe("browser");
    expect(familyOf("computer_click")).toBe("desktop");
    expect(familyOf("open_on_screen")).toBe("desktop");
  });

  it("starts a video or writing job with no screen tools, only their loaders", () => {
    const tools = workerTools();
    const ctx = context();
    const on = gateToolFamilies(tools, ctx, startingFamilies("executor", "Render a 60s reel with kinetic-reel and write the plan to plan.md"));
    expect(on.size).toBe(0);
    expect(active(tools, ctx).sort()).toEqual(
      ["bash", "computer_memory", "load_browser_tools", "load_desktop_tools", "read", "wait", "web_search", "write"].sort(),
    );
  });

  it("loads a family on request, from the next step", async () => {
    const tools = workerTools();
    const ctx = context();
    gateToolFamilies(tools, ctx, new Set());
    const answer = await (tools.load_browser_tools as { execute: (input: unknown, options: unknown) => Promise<string> }).execute({}, {});
    expect(answer).toContain("browser_click");
    expect(active(tools, ctx)).toContain("browser_snapshot");
    expect(active(tools, ctx)).not.toContain("load_browser_tools");
    expect(active(tools, ctx)).not.toContain("computer_click");
  });

  it("starts with what the brief or kind plainly needs", () => {
    expect([...startingFamilies("executor", "Log in to the supplier site and download the invoice")]).toEqual(["browser"]);
    expect([...startingFamilies("computer", "Fix the printer settings")].sort()).toEqual(["browser", "desktop"]);
    expect(startingFamilies("executor", "Research the top 5 CRM tools and write a comparison").size).toBe(0);
  });

  it("starts a small plugin the brief names, and leaves a large one to search", () => {
    const ctx = context();
    ctx.pluginLoaders!.set("gmail_load_tools", "plugin:gmail").set("resend_load_tools", "plugin:resend");
    for (let index = 0; index < 9; index += 1) ctx.pluginGates!.set(`gmail_t${index}`, "plugin:gmail");
    for (let index = 0; index < 137; index += 1) ctx.pluginGates!.set(`resend_t${index}`, "plugin:resend");
    startNamedPlugins(ctx, "Sort my Gmail inbox and draft replies; do not use Resend for this");
    expect(ctx.enabledToolSets!.has("plugin:gmail")).toBe(true);
    expect(ctx.enabledToolSets!.has("plugin:resend")).toBe(false);
  });
});

describe("mentionedToUse", () => {
  it("ignores a name the brief says not to use", () => {
    expect(mentionedToUse("This is the ONLY approved stack — no hand-rolled CSS slides, no HyperFrames.", "hyperframes")).toBe(false);
    expect(mentionedToUse("Never use kokoro-tts here.", "kokoro-tts")).toBe(false);
    expect(mentionedToUse("Use the kinetic-reel skill.", "kinetic-reel")).toBe(true);
    expect(mentionedToUse("No slides. Build it with hyperframes.", "hyperframes")).toBe(true);
  });
});
