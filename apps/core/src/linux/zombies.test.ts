import { describe, expect, it } from "vitest";
import { reapCheck } from "./zombies.js";

const desktop = ["sleep", "Xvfb", "x11vnc", "chromium", "chrome_crashpad", "agent-browser-l"];

describe("reapCheck", () => {
  it("leaves a computer with few dead processes alone", () => {
    expect(reapCheck(desktop, desktop.length + 100, 8192)).toEqual({ restart: false });
  });

  it("restarts an idle computer that is half full of dead processes", () => {
    expect(reapCheck(desktop, desktop.length + 4200, 8192).restart).toBe(true);
  });

  it("waits while real work runs on a half-full computer", () => {
    expect(reapCheck([...desktop, "ffmpeg"], 4300, 8192)).toEqual({ restart: false });
  });

  it("restarts a full computer even while work runs, since nothing new can start", () => {
    expect(reapCheck([...desktop, "python3"], 8192, 8192).restart).toBe(true);
  });
});
