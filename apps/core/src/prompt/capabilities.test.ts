import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allToolDefinitions } from "@kuru/agent-tools";
import { buildInstructions } from "./build-instructions.js";
import { aboutWorkAgent, CAPABILITY_LINES, WORKER_LINES } from "./capabilities.js";
import { parsePromptFile } from "./prompts.js";

const sections = parsePromptFile(readFileSync(new URL("../../../../prompts/about.md", import.meta.url), "utf8"));

describe("what an agent knows about itself", () => {
  it("says it is a Kuru agent and what the person has in the app", () => {
    const text = aboutWorkAgent();
    expect(text).toContain("You are an agent in Kuru");
    expect(text).toContain("never name the model behind you");
    expect(text).toContain("screen button");
  });

  it("lists a capability only while the tool behind it exists, and has a line for every one written", () => {
    const tools = new Set(allToolDefinitions.map((def) => def.name));
    for (const line of [...CAPABILITY_LINES, ...WORKER_LINES]) {
      expect(tools.has(line.needs), `${line.key} needs ${line.needs}, which is not a tool`).toBe(true);
      expect(sections.has(line.key), `prompts/about.md has no "# ${line.key}"`).toBe(true);
    }
    // A line written in the file but never shown would be a capability nobody is told about.
    const mapped = new Set([...CAPABILITY_LINES, ...WORKER_LINES].map((line) => line.key));
    for (const key of sections.keys()) {
      if (key.startsWith("can-") && key !== "can-heading") expect(mapped.has(key), `"# ${key}" is not in capabilities.ts`).toBe(true);
      if (key.startsWith("worker-")) expect(mapped.has(key), `"# ${key}" is not in capabilities.ts`).toBe(true);
    }
  });

  it("tells a work agent about its own shell, browser and workers", () => {
    const text = aboutWorkAgent();
    for (const tool of ["`bash`", "`write`", "`browser_navigate`", "`spawn_worker`", "`send_message`", "`enable_tools`"]) expect(text).toContain(tool);
    expect(text).toContain("use any website like a person");
    expect(text).not.toContain("{{");
  });

  it("stays small, because it is resent on every model step", () => {
    expect(aboutWorkAgent().length).toBeLessThan(4_200);
  });

  it("gives a companion and the default agent the short form, with no computer or workers", () => {
    for (const kind of ["companion", "support"]) {
      const text = buildInstructions({ name: "Mia", role: "Friend", personality: "", job: "Talk.", kind });
      expect(text).toContain("You are an agent in Kuru");
      expect(text).not.toContain("## What you can do");
    }
    expect(buildInstructions({ name: "Ada", role: "Maker", personality: "", job: "Make." })).toContain("## What you can do");
  });
});
