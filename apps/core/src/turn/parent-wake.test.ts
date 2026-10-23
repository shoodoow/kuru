import { describe, expect, it } from "vitest";
import { cleanReport } from "./parent-wake.js";

describe("cleanReport", () => {
  it("keeps a stopped worker's whole report, note and findings", () => {
    const report = `[This worker was stopped before it finished.] Findings: render with core/render/video.mjs. ${"x".repeat(400)}`;
    expect(cleanReport(report)).toContain("core/render/video.mjs");
    expect(cleanReport(report).length).toBeGreaterThan(400);
  });

  it("cuts raw dumps short", () => {
    expect(cleanReport(`[{"id":1}${",{}".repeat(200)}]`).length).toBe(200);
    expect(cleanReport(`<!DOCTYPE html>${"x".repeat(400)}`).length).toBe(200);
    expect(cleanReport(`{"error":"${"x".repeat(400)}"}`).length).toBe(200);
  });
});
