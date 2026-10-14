import { describe, expect, it } from "vitest";
import { parseFold, renderKnown, renderSlice } from "./summarize-fold.js";

const slice = [
  { id: "m1", agentId: null, body: "Sara runs marketing at Acme", createdAt: new Date("2026-03-01T10:00:00Z") },
  { id: "m2", agentId: "a", body: "Noted.", createdAt: new Date("2026-03-01T10:01:00Z") },
  { id: "m3", agentId: null, body: "Budget is now 12k", createdAt: new Date("2026-03-02T09:00:00Z") },
];
const known = [{ id: "fact-1", subject: "Acme", body: "Ad budget is 8,000 USD per month." }];

describe("renderSlice / renderKnown", () => {
  it("numbers and dates each line and labels the facts", () => {
    expect(renderSlice(slice).split("\n")[0]).toBe("[1] 2026-03-01 person: Sara runs marketing at Acme");
    expect(renderKnown(known)).toBe("M1: Acme: Ad budget is 8,000 USD per month.");
    expect(renderKnown([])).toBe("(none yet)");
  });
});

describe("parseFold", () => {
  it("closes the open items the slice settled, and only real ones", () => {
    const open = [
      { id: "open-1", body: "Waiting for the logins." },
      { id: "open-2", body: "Waiting on the logo." },
    ];
    const out = parseFold(["done O1", "done O9", "done O1"].join("\n"), slice, known, open);
    expect(out.closed).toEqual(["open-1"]);
  });

  it("reads summary lines, facts and updates, each citing its own message", () => {
    const out = parseFold(
      [
        "decisions [3]: Budget raised to 12k.",
        "- fact [1] person | Sara Ahmadi: Head of marketing at Acme.",
        "fact [1] preference | : Wants short replies.",
        "update M1 [3]: Ad budget is 12,000 USD per month.",
        "random chatter that fits no rule",
      ].join("\n"),
      slice,
      known,
    );
    expect(out.items).toEqual([{ key: "decisions", body: "Budget raised to 12k.", messageId: "m3" }]);
    expect(out.facts).toEqual([
      { kind: "person", subject: "Sara Ahmadi", body: "Head of marketing at Acme.", messageId: "m1" },
      { kind: "preference", subject: null, body: "Wants short replies.", messageId: "m1" },
      { kind: "fact", subject: "Acme", body: "Ad budget is 12,000 USD per month.", messageId: "m3", replaces: "fact-1" },
    ]);
  });

  it("cites the newest message when the line number is missing or out of range", () => {
    const out = parseFold("topics: planning\nopen [99]: logo pending", slice, []);
    expect(out.items.map((item) => item.messageId)).toEqual(["m3", "m3"]);
  });

  it("ignores an update that points at an unknown fact", () => {
    expect(parseFold("update M7 [1]: something", slice, known).facts).toEqual([]);
  });
});
