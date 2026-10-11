import { workerToolNames as agentWorkerToolNames } from "@kuru/agent-tools";

/**
 * @deprecated Use workerToolNames from @kuru/agent-tools.
 * Kept for tests that assert computer tool names are a subset of worker tools.
 */
export function profileToolNames(): string[] {
  return agentWorkerToolNames(true).filter((name) =>
    [
      "bash",
      "computer_click",
      "computer_key",
      "computer_mouse",
      "computer_screenshot",
      "computer_type",
      "glob",
      "grep",
      "read",
      "web_fetch",
      "web_search",
      "write",
    ].includes(name),
  );
}
