import { describe, expect, it } from "vitest";
import { profileToolNames } from "../computer/profile-tools.js";
import { workerToolNames } from "../rooms/subagents.js";
import { dispatcherToolNames } from "../turn/tools/registry.js";

describe("dispatcher SDK tools", () => {
  it("registers built-in dispatcher tools in stable sorted order", () => {
    const names = dispatcherToolNames();
    expect(names).toEqual([
      "add_to_group",
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
    ]);
    expect(dispatcherToolNames()).toEqual(names);
    const parentCheap = new Set(["glob", "grep", "read", "web_fetch", "web_search"]);
    for (const name of profileToolNames()) {
      if (parentCheap.has(name)) expect(names).toContain(name);
      else expect(names).not.toContain(name);
    }
    expect(workerToolNames(true)).toEqual(
      expect.arrayContaining([...profileToolNames(), "read_history", "read_skill", "browser_snapshot", "list_skills"]),
    );
    expect(workerToolNames(true)).toContain("web_search");
    expect(workerToolNames(false)).toEqual(["list_skills", "read_history", "read_skill", "refresh_skills"].sort());
  });
});
