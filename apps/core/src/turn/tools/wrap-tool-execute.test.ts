import { describe, expect, it } from "vitest";
import { dispatcherToolBudgetError, dispatcherToolBudgetMs } from "./dispatcher-tool-budget.js";
import type { ToolContext } from "./context.js";
import { MAX_CALLS_PER_STEP, wrapToolExecute } from "./wrap-tool-execute.js";

describe("dispatcher tool budgets", () => {
  it("does not cap coordination tools", () => {
    expect(dispatcherToolBudgetMs("send_message")).toBeNull();
    expect(dispatcherToolBudgetMs("spawn_worker")).toBeNull();
    expect(dispatcherToolBudgetMs("delegate")).toBeNull();
  });

  it("gives web tools a longer parent budget", () => {
    expect(dispatcherToolBudgetMs("web_fetch")).toBe(20_000);
    expect(dispatcherToolBudgetMs("web_search")).toBe(20_000);
    expect(dispatcherToolBudgetMs("read")).toBe(8_000);
  });

  it("formats timeout errors with seconds", () => {
    expect(dispatcherToolBudgetError(20_000)).toMatch(/20s/);
  });
});

describe("a model that floods a step or repeats a call", () => {
  it("gives the chat agent its own shell 20 seconds and its browser 40", () => {
    expect(dispatcherToolBudgetMs("bash")).toBe(20_000);
    expect(dispatcherToolBudgetMs("browser_navigate")).toBe(40_000);
  });

  it("runs a sensible number of calls in one step and ignores the rest in two words", async () => {
    const ctx = {} as ToolContext;
    let ran = 0;
    const call = wrapToolExecute(ctx, "worker", "bash", async () => {
      ran += 1;
      return "ok";
    });
    const results: unknown[] = [];
    // Different inputs, so this is the flood rule and not the repeated-call rule.
    for (let index = 0; index < 200; index += 1) results.push(await call({ command: `echo ${index}` }));
    expect(ran).toBe(MAX_CALLS_PER_STEP);
    expect(JSON.stringify(results[MAX_CALLS_PER_STEP])).toContain("in one step");
    expect(results.at(-1)).toEqual({ error: "Ignored." });
    expect(ctx.stuck).toBe(true);
    // The next step starts from zero.
    ctx.stepCalls = 0;
    expect(await call({ command: "echo next" })).toBe("ok");
  });

  it("explains a repeated call once, then answers every repeat in two words", async () => {
    const ctx = {} as ToolContext;
    let ran = 0;
    const call = wrapToolExecute(ctx, "worker", "browser_navigate", async () => {
      ran += 1;
      return "page";
    });
    const results: unknown[] = [];
    for (let index = 0; index < 6; index += 1) {
      ctx.stepCalls = 0;
      results.push(await call({ url: "https://example.com/" }));
    }
    expect(ran).toBe(2);
    expect(JSON.stringify(results[2])).toContain("Same call 3 times");
    expect(results.slice(3)).toEqual([{ error: "Ignored: repeated call." }, { error: "Ignored: repeated call." }, { error: "Ignored: repeated call." }]);
    expect(ctx.stuck).toBe(true);
  });
});
