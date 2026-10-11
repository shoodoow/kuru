import { describe, expect, it } from "vitest";
import { fillPrompt, parsePromptFile, prompt, promptKeys } from "./prompts.js";

describe("parsePromptFile", () => {
  it("splits on level-1 headings and ignores the note before the first one", () => {
    const sections = parsePromptFile("Note for humans.\n\n# first\nHello\n\n## Sub\nkept\n\n# second\nBye\n");
    expect([...sections.keys()]).toEqual(["first", "second"]);
    expect(sections.get("first")).toBe("Hello\n\n## Sub\nkept");
    expect(sections.get("second")).toBe("Bye");
  });
});

describe("fillPrompt", () => {
  it("fills placeholders and throws on a missing value", () => {
    expect(fillPrompt("Step {{n}} of {{max}}", { n: 2, max: 6 })).toBe("Step 2 of 6");
    expect(() => fillPrompt("Hi {{name}}")).toThrow(/name/);
  });
});

describe("prompt files on disk", () => {
  it("loads every section the code asks for", () => {
    expect(prompt("dispatcher", "stall-nudge").length).toBeGreaterThan(10);
    expect(prompt("worker-rules", "wrap-up", { steps: 10, unused: 8 })).toContain("10");
    expect(promptKeys("cues")).toContain("worker-results");
    expect(promptKeys("memory")).toContain("fold");
  });
});

describe("tool descriptions", () => {
  it("exist for every tool the agents can call", async () => {
    const { allToolDefinitions } = await import("@kuru/agent-tools");
    const { promptKeys } = await import("./prompts.js");
    const keys = new Set(promptKeys("tools"));
    const missing = allToolDefinitions.map((def) => def.name).filter((name) => !keys.has(name));
    expect(missing).toEqual([]);
  });
});
