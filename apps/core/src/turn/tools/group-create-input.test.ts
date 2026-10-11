import { groupCreateInputSchema } from "@kuru/agent-tools";
import { describe, expect, it } from "vitest";

describe("groupCreateInputSchema", () => {
  it("accepts title only", () => {
    expect(groupCreateInputSchema.parse({ title: "Social Growth Team" })).toEqual({
      title: "Social Growth Team",
      memberIds: [],
    });
  });

  it("accepts explicit empty memberIds", () => {
    expect(groupCreateInputSchema.parse({ title: "Team", memberIds: [] })).toMatchObject({ memberIds: [] });
  });

  it("rejects non-uuid member ids", () => {
    expect(() => groupCreateInputSchema.parse({ title: "Team", memberIds: ["Bob"] })).toThrow();
  });
});
