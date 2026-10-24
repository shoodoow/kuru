import { dispatcherToolNames, groupCreateInputSchema, toolsForSurface, workerToolNames } from "@kuru/agent-tools";
import { describe, expect, it } from "vitest";
import { profileToolNames } from "../../computer/profile-tools.js";

describe("agent-tools catalog", () => {
  it("matches dispatcher registration list", () => {
    expect(dispatcherToolNames()).toEqual([
      "add_to_group",
      "apply_patch",
      "bash",
      "browser_navigate",
      "browser_read",
      "browser_snapshot",
      "check_worker",
      "connect_social",
      "correct_agent_memory",
      "correct_memory",
      "create_group",
      "create_routine",
      "delegate",
      "delete_group",
      "delete_routine",
      "delete_routines",
      "edit",
      "enable_tools",
      "fire_agent",
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
      "set_my_profile",
      "set_team_brief",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
      "update_teammate",
      "web_fetch",
      "web_search",
      "write",
    ]);
  });

  it("worker names align with profile tools when Linux exists", () => {
    expect(workerToolNames(false)).toEqual(["ask_agent", "list_skills", "read_history", "read_skill", "refresh_skills", "todo_write"].sort());
    expect(workerToolNames(true)).toContain("browser_snapshot");
    expect(workerToolNames(true)).toContain("browser_click");
    for (const name of profileToolNames()) {
      expect(workerToolNames(true)).toContain(name);
    }
    // The chat agent runs a quick command and reads a page itself; acting on a page and the desktop stay with workers.
    expect(toolsForSurface("dispatcher").map((d) => d.name)).toEqual(expect.arrayContaining(["bash", "write", "browser_read"]));
    expect(toolsForSurface("dispatcher").map((d) => d.name)).not.toContain("browser_click");
    expect(toolsForSurface("dispatcher").map((d) => d.name)).not.toContain("computer_click");
    expect(toolsForSurface("dispatcher").map((d) => d.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "read", "glob", "grep"]),
    );
  });

  it("accepts title-only create_group", () => {
    expect(groupCreateInputSchema.parse({ title: "Team" })).toMatchObject({ memberIds: [] });
  });
});
