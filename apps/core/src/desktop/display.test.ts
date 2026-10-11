import { describe, expect, it } from "vitest";
import { chromeLauncher, clampPoint, jwmConfig, sessionForUid } from "./desktop.js";

/**
 * Locks the single-source-of-truth display contract: agent tools, bash
 * DISPLAY, screenshots, and the noVNC viewer all derive the same :N and ports
 * from the profile's Linux user id, so restarts can never desync viewer vs
 * agent and no two agents on one computer can share a screen.
 */
describe("deterministic display", () => {
  it("derives a stable display and ports from the user id", () => {
    expect(sessionForUid(1000)).toEqual({ display: 10, rfbPort: 5910, novncPort: 6910, cdpPort: 9210 });
    expect(sessionForUid(1017)).toEqual(sessionForUid(1017));
  });

  it("gives every profile on a shared container its own display and ports", () => {
    const sessions = Array.from({ length: 990 }, (_unused, slot) => sessionForUid(1000 + slot));
    const ports = sessions.flatMap((session) => [session.rfbPort, session.novncPort, session.cdpPort]);
    expect(new Set(sessions.map((session) => session.display)).size).toBe(990);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("refuses user ids outside the agent range", () => {
    expect(() => sessionForUid(0)).toThrow(/no desktop slot/);
    expect(() => sessionForUid(1990)).toThrow(/no desktop slot/);
    expect(() => sessionForUid(Number.NaN)).toThrow(/no desktop slot/);
  });

  it("clamps grounding coordinates to 1280x800", () => {
    expect(clampPoint(200, 80)).toEqual({ x: 200, y: 80 });
    expect(clampPoint(-5, 9999)).toEqual({ x: 0, y: 799 });
    expect(clampPoint(1279.6, 100)).toEqual({ x: 1279, y: 100 });
    expect(clampPoint(NaN, 10)).toEqual({ x: 0, y: 10 });
  });
});

/** Locks the panel a person sees on the agent's screen. */
describe("desktop panel", () => {
  it("lists open windows, so a minimised one can be brought back", () => {
    const config = jwmConfig(10);
    expect(config).toContain("<TaskList");
    expect(config).toContain("exec:/tmp/desktop-10/chrome.sh");
  });

  it("raises Chrome when it is already open instead of starting another", () => {
    const script = chromeLauncher(19222);
    expect(script.indexOf("windowactivate")).toBeGreaterThan(-1);
    expect(script.indexOf("windowactivate")).toBeLessThan(script.indexOf("exec chromium"));
    expect(script).toContain("--remote-debugging-port=19222");
  });
});
