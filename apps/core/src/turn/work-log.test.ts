import { describe, expect, it } from "vitest";
import { renderWorkLog, weaveWorkLogs, workEntry } from "./work-log.js";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));

describe("workEntry", () => {
  it("keeps only the title and address of a page tree", () => {
    const tree = "✓ Results - Google Search\n  https://www.google.com/search?q=x\n- generic\n  - link \"Skip\" [ref=e1]\n".repeat(20);
    const entry = workEntry("browser_navigate", { url: "https://www.google.com/search?q=x" }, tree, false);
    expect(entry.output).toContain("Results - Google Search");
    expect(entry.output).not.toContain("[ref=e1]");
    expect(workEntry("browser_read", {}, "Plain page text", false).output).toBe("Plain page text");
  });

  it("keeps the identifying argument and clips long output", () => {
    const entry = workEntry("read", { path: "/shared/a.md" }, "x".repeat(5000), false);
    expect(entry.input).toBe("/shared/a.md");
    expect(entry.output.length).toBeLessThan(1600);
    expect(entry.failed).toBeUndefined();
  });
});

describe("renderWorkLog", () => {
  const row = {
    runId: "r1",
    cue: "worker results: the render finished",
    createdAt: at(1),
    entries: [{ tool: "read_skill", input: "hyperframes-core", output: "y".repeat(900) }],
  };

  it("shows real output for recent runs and a digest for old ones", () => {
    expect(renderWorkLog(row, true)).toContain("y".repeat(900));
    const brief = renderWorkLog(row, false);
    expect(brief).toContain("read_skill hyperframes-core");
    expect(brief).not.toContain("y".repeat(200));
    expect(brief).toContain("worker results");
  });
});

describe("weaveWorkLogs", () => {
  it("puts a run's work just before that run's first reply", () => {
    const rows = [
      { runId: "r1", agentId: null, createdAt: at(0) },
      { runId: "r1", agentId: "amily", createdAt: at(1) },
      { runId: "r2", agentId: null, createdAt: at(5) },
    ];
    const messages = [
      { role: "user" as const, content: "install the skill" },
      { role: "assistant" as const, content: "Installed." },
      { role: "user" as const, content: "now build the intro" },
    ];
    const woven = weaveWorkLogs(rows, messages, [
      { runId: "r1", cue: null, createdAt: at(1), entries: [{ tool: "web_search", input: "hyperframes", output: "found" }] },
    ]);
    expect(woven).toHaveLength(4);
    expect(String(woven[1]!.content)).toContain("web_search hyperframes");
    expect(woven[2]!.content).toBe("Installed.");
  });

  it("keeps a silent run's work in time order", () => {
    const rows = [
      { runId: "r1", agentId: null, createdAt: at(0) },
      { runId: "r3", agentId: null, createdAt: at(9) },
    ];
    const messages = [
      { role: "user" as const, content: "start it" },
      { role: "user" as const, content: "any news?" },
    ];
    const woven = weaveWorkLogs(rows, messages, [
      { runId: "r2", cue: "worker results: done", createdAt: at(4), entries: [] },
    ]);
    expect(woven.map((m) => String(m.content).slice(0, 12))).toEqual(["start it", "[your work l", "any news?"]);
  });

  it("returns the messages untouched when there is no work to show", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(weaveWorkLogs([{ runId: null, agentId: null, createdAt: at(0) }], messages, [])).toBe(messages);
  });
});
