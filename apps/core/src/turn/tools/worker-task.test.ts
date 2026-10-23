import { describe, expect, it } from "vitest";
import { assembleBrief, redirectNote, validateWorkerTask } from "./worker-task.js";

describe("validateWorkerTask", () => {
  it("auto-strips chromium kills instead of retry-burning", () => {
    const r = validateWorkerTask(
      "Check the Instagram profile: read_skill chrome-devtools, pkill chromium then browser_snapshot and report the counts.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).not.toMatch(/pkill/i);
  });

  it("accepts a plain-language brief without section labels", () => {
    const r = validateWorkerTask(
      "Check what exists in the home directory and /shared. Run ls -la on both and list any hyperframes.json you find.",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a brief too short to act on", () => {
    const r = validateWorkerTask("check my instagram");
    expect(r.ok).toBe(false);
  });

  it("accepts a long, complete brief and rejects only an absurdly long one", () => {
    expect(validateWorkerTask(`Build everything. ${"x".repeat(4100)}`).ok).toBe(true);
    const r = validateWorkerTask(`Build everything. ${"x".repeat(17000)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/too long/i);
  });
});

describe("assembleBrief", () => {
  it("keeps the goal first and tags each part that was given", () => {
    const brief = assembleBrief({ task: "Render the intro video.", context: "Style: blueprint.", checks: "Open three frames.", deliver: "~/work/intro.mp4" });
    expect(brief.split("\n")[0]).toBe("Render the intro video.");
    expect(brief).toContain("<context>\nStyle: blueprint.\n</context>");
    expect(brief).toContain("<deliver>\n~/work/intro.mp4\n</deliver>");
    expect(brief).not.toContain("<rules>");
  });
});

describe("redirectNote", () => {
  it("puts what is done before the next action and skips empty parts", () => {
    expect(redirectNote({ done: "Scene built in ~/work/a.", next: "Render it with render.mjs." })).toBe(
      "Already done: Scene built in ~/work/a.\n\nNext: Render it with render.mjs.",
    );
    expect(redirectNote({ next: "Use the blue logo." })).toBe("Next: Use the blue logo.");
  });
});
