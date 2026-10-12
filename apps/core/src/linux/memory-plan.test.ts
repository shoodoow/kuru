import { describe, expect, it } from "vitest";
import { inGb, largestGrant, planMemory } from "./memory-plan.js";

const GB = 1024 * 1024 * 1024;

describe("memory plan", () => {
  it("keeps a reserve and gives a small everyday limit on a 16 GB laptop", () => {
    const plan = planMemory(16 * GB);
    expect(inGb(plan.reserveBytes)).toBe("4 GB");
    expect(inGb(plan.poolBytes)).toBe("12 GB");
    expect(inGb(plan.baselineBytes)).toBe("3 GB");
  });

  it("lets one job borrow 10 GB when the other computers use 2 GB between them", () => {
    const plan = planMemory(16 * GB);
    expect(inGb(largestGrant(plan, 2 * GB))).toBe("10 GB");
    expect(inGb(largestGrant(plan, 0))).toBe("12 GB");
  });

  it("never lends less than the everyday limit, however crowded", () => {
    const plan = planMemory(16 * GB);
    expect(largestGrant(plan, 40 * GB)).toBe(plan.baselineBytes);
  });

  it("scales with the machine and honours the setting", () => {
    expect(inGb(planMemory(64 * GB).baselineBytes)).toBe("8 GB");
    expect(inGb(planMemory(8 * GB).baselineBytes)).toBe("2 GB");
    expect(inGb(planMemory(16 * GB, 6).baselineBytes)).toBe("6 GB");
    // A setting larger than the machine allows is cut to what there is.
    expect(inGb(planMemory(16 * GB, 64).baselineBytes)).toBe("12 GB");
  });
});
