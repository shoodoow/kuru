import { dispatcherToolNames, groupCreateInputSchema, toolsForSurface, workerToolNames } from "@nano-agents/agent-tools";
import { describe, expect, it } from "vitest";
import { profileToolNames } from "../../computer/profile-tools.js";

describe("agent-tools catalog", () => {
  it("matches dispatcher registration list", () => {
    expect(dispatcherToolNames()).toEqual([
      "add_to_group",
      "check_worker",
      "correct_agent_memory",
      "correct_memory",
      "create_group",
      "create_routine",
      "delegate",
      "delete_group",
      "delete_routine",
      "delete_routines",
      "enable_tools",
      "glob",
      "grep",
      "hire_agent",
      "hire_subagent",
      "list_groups",
      "list_routines",
      "list_skills",
      "list_team",
      "message_agent",
      "notify_user",
      "open_on_screen",
      "react_to_message",
      "read",
      "read_agent_memory",
      "read_history",
      "read_skill",
      "redirect_worker",
      "refresh_skills",
      "remember_fact",
      "remember_for_agent",
      "search_memory",
      "send_message",
      "set_brief",
      "set_team_brief",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
      "update_teammate",
      "web_fetch",
      "web_search",
    ]);
  });

  it("worker names align with profile tools when Linux exists", () => {
    expect(workerToolNames(false)).toEqual(["list_skills", "read_history", "read_skill", "refresh_skills"].sort());
    expect(workerToolNames(true)).toContain("browser_snapshot");
    expect(workerToolNames(true)).toContain("browser_click");
    for (const name of profileToolNames()) {
      expect(workerToolNames(true)).toContain(name);
    }
    expect(toolsForSurface("dispatcher").map((d) => d.name)).not.toContain("bash");
    expect(toolsForSurface("dispatcher").map((d) => d.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "read", "glob", "grep"]),
    );
  });

  it("accepts title-only create_group", () => {
    expect(groupCreateInputSchema.parse({ title: "Team" })).toMatchObject({ memberIds: [] });
  });
});
