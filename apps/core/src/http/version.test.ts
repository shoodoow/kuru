import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KURU_VERSION, MIN_APP_VERSION, compareVersions, versionNotice } from "@kuru/shared";
import { describe, expect, it } from "vitest";

describe("release version", () => {
  it("is the same in the code and in the root package.json", () => {
    const root = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../package.json"), "utf8")) as { version: string };
    expect(root.version).toBe(KURU_VERSION);
    expect(readFileSync(join(import.meta.dirname, "../../../../CHANGELOG.md"), "utf8")).toContain(`## ${KURU_VERSION}`);
  });

  it("orders versions by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });

  it("accepts this app on this server, and names the side to update otherwise", () => {
    expect(versionNotice({ version: KURU_VERSION, minAppVersion: MIN_APP_VERSION })).toBeNull();
    expect(versionNotice({ version: "9.0.0", minAppVersion: "9.0.0" })).toMatch(/Update the app/);
    // A server from before versions were reported still works until the app needs something newer.
    expect(versionNotice({})).toBeNull();
    expect(versionNotice({ version: "0.1.0" }, "0.2.0")).toBeNull();
  });
});
