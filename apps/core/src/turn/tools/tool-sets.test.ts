import { toolNamesInSet } from "@kuru/agent-tools";
import { describe, expect, it } from "vitest";
import { activeDispatcherTools, allowedForKind, initialToolSets, isRequestableToolSet } from "./tool-sets.js";

const supportTools = ["set_brief", "hire_agent", "read_agent_memory", "remember_for_agent", "correct_agent_memory"];
const handsOn = ["spawn_worker", "redirect_worker", "open_on_screen", "read", "enable_tools", "hire_subagent", "create_routine"];

describe("tool sets by agent kind", () => {
  it("leaves a work agent unrestricted and never starts it with the support set", () => {
    expect(allowedForKind("work")).toBeUndefined();
    expect(allowedForKind(undefined)).toBeUndefined();
    expect(initialToolSets({ roomKind: "direct", hasTeam: true, hasRoutines: true, agentKind: "work" })).toEqual(["team", "routines"]);
  });

  it("gives the support agent its own set and nothing hands-on", () => {
    const allowed = allowedForKind("support") ?? [];
    expect(toolNamesInSet("support").sort()).toEqual([...supportTools].sort());
    for (const name of supportTools) expect(allowed).toContain(name);
    for (const name of handsOn) expect(allowed).not.toContain(name);
    expect(initialToolSets({ roomKind: "direct", hasTeam: true, hasRoutines: true, agentKind: "support" })).toEqual(["support"]);
  });

  it("keeps a companion to conversation, memory and lookups", () => {
    const allowed = allowedForKind("companion") ?? [];
    expect(allowed).toContain("remember_fact");
    expect(allowed).toContain("web_search");
    for (const name of [...handsOn, ...supportTools]) expect(allowed).not.toContain(name);
    expect(initialToolSets({ roomKind: "direct", hasTeam: true, hasRoutines: true, agentKind: "companion" })).toEqual([]);
  });

  it("does not let an agent turn the support set on, or see its tools without it", () => {
    expect(isRequestableToolSet("support")).toBe(false);
    expect(isRequestableToolSet("team")).toBe(true);
    const names = ["send_message", "enable_tools", "set_brief", "hire_agent", "delegate"];
    expect(activeDispatcherTools(names, new Set(["team"]))).toEqual(["send_message", "enable_tools", "delegate"]);
    // enable_tools goes away once every set an agent may ask for is on.
    expect(activeDispatcherTools(names, new Set(["team", "routines", "admin"]))).toEqual(["send_message", "delegate"]);
  });
});
