import { describe, expect, test } from "vitest";
import {
  kindHasTool,
  packWorkerJobDescription,
  unpackWorkerJobDescription,
  workerPreambleFor,
  WORKER_KINDS,
} from "./worker-kinds.js";

describe("worker kinds", () => {
  test("every built-in kind loads a prompt", () => {
    for (const kind of WORKER_KINDS) {
      if (kind === "custom") continue;
      const text = workerPreambleFor(kind);
      expect(text.length).toBeGreaterThan(40);
      expect(text).toContain("Findings:");
      expect(text).toContain("Check the result before you report");
      expect(text).toContain("never a chat message");
    }
  });

  test("preamble tells the worker to keep going until done, with no step budget", () => {
    const text = workerPreambleFor("executor");
    expect(text).toContain("## How to work");
    expect(text).not.toMatch(/Step budget/);
    expect(workerPreambleFor("browser")).toContain("## How to work");
  });

  test("custom requires instructions", () => {
    expect(() => workerPreambleFor("custom")).toThrow(/instructions/);
    expect(workerPreambleFor("custom", "Only list open ports.")).toContain("Only list open ports.");
  });

  test("pack/unpack round-trips built-in and custom", () => {
    const packed = packWorkerJobDescription({ kind: "explore", jobDescription: "Find the schema." });
    expect(unpackWorkerJobDescription(packed)).toEqual({
      kind: "explore",
      jobDescription: "Find the schema.",
    });

    const custom = packWorkerJobDescription({
      kind: "custom",
      jobDescription: "Ship the report.",
      instructions: "Use CSV only.\nNo screenshots.",
    });
    expect(unpackWorkerJobDescription(custom)).toEqual({
      kind: "custom",
      jobDescription: "Ship the report.",
      instructions: "Use CSV only.\nNo screenshots.",
    });
  });

  test("legacy job descriptions default to computer", () => {
    expect(unpackWorkerJobDescription("Do the desktop thing.")).toEqual({
      kind: "computer",
      jobDescription: "Do the desktop thing.",
    });
  });

  test("a worker that runs commands or reads is not handed the tools for acting on a page", () => {
    for (const tool of ["bash", "write", "read", "web_fetch", "ask_agent", "computer_memory", "browser_navigate", "browser_read"]) {
      expect(kindHasTool("shell", tool)).toBe(true);
    }
    for (const tool of ["browser_click", "browser_fill", "browser_upload", "computer_click", "computer_screenshot"]) {
      expect(kindHasTool("shell", tool)).toBe(false);
      expect(kindHasTool("docs", tool)).toBe(false);
      // The kinds that use a site or the desktop, and the general one, keep everything.
      expect(kindHasTool("browser", tool)).toBe(true);
      expect(kindHasTool("computer", tool)).toBe(true);
      expect(kindHasTool("executor", tool)).toBe(true);
      expect(kindHasTool("custom", tool)).toBe(true);
    }
  });
});
