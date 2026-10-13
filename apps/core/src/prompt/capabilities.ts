import { dispatcherToolNames, workerToolNames } from "@kuru/agent-tools";
import { prompt } from "./prompts.js";

/**
 * Each "what you can do" line and the tool that makes it true.
 * Why: a list written by hand says an agent can do things after the tool is
 * gone, and stays silent about new ones. A line is shown only while its tool
 * exists, and a test fails when prompts/about.md and this list disagree.
 */
export const CAPABILITY_LINES: readonly { key: string; needs: string }[] = [
  { key: "can-lookup", needs: "web_search" },
  { key: "can-files", needs: "read" },
  { key: "can-write", needs: "write" },
  { key: "can-shell", needs: "bash" },
  { key: "can-browser", needs: "browser_navigate" },
  { key: "can-screen", needs: "open_on_screen" },
  { key: "can-messages", needs: "send_message" },
  { key: "can-memory", needs: "remember_fact" },
  { key: "can-workers", needs: "spawn_worker" },
  { key: "can-skills", needs: "read_skill" },
  { key: "can-agents", needs: "message_agent" },
  { key: "can-social", needs: "connect_social" },
  { key: "can-sets", needs: "enable_tools" },
];

/** What a background worker adds, each with the worker tool behind it. */
export const WORKER_LINES: readonly { key: string; needs: string }[] = [
  { key: "worker-shell", needs: "bash" },
  { key: "worker-browser", needs: "browser_click" },
  { key: "worker-desktop", needs: "computer_click" },
  { key: "worker-memory", needs: "computer_memory" },
];

/**
 * What a work agent is told about itself: the product it is part of and what it can do.
 * Why: asked "what are you?" or "can you make a video?", agents answered as a
 * general chatbot and sent the person to online tools, because nothing in
 * their prompt said they were a Kuru agent with a computer, a browser and workers.
 * Input: nothing; it reads the tool list. Output: the text placed after the standing prompt.
 */
export function aboutWorkAgent(): string {
  const own = new Set(dispatcherToolNames());
  const worker = new Set(workerToolNames(true));
  // Indented here: the prompt loader trims each section, and these sit under the worker line.
  const workerLines = WORKER_LINES.filter((line) => worker.has(line.needs)).map((line) => `  ${prompt("about", line.key)}`);
  const lines = CAPABILITY_LINES.filter((line) => own.has(line.needs)).map((line) =>
    line.key === "can-workers" ? prompt("about", line.key, { worker: workerLines.join("\n") }) : prompt("about", line.key),
  );
  return [prompt("about", "about"), [prompt("about", "can-heading"), ...lines].join("\n"), prompt("about", "cannot")].join("\n\n");
}

/** The short form, for an agent kept for conversation and for the account's default agent. */
export const aboutShort = (): string => prompt("about", "about-short");

/** What a background worker is told about where it is. */
export const aboutWorker = (): string => prompt("about", "about-worker");
