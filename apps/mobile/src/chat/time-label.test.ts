import { describe, expect, it } from "vitest";
import { startsTimeGroup, timeLabel } from "./time-label";

const at = (year: number, month: number, day: number, hour: number, minute: number): string =>
  new Date(year, month - 1, day, hour, minute).toISOString();

describe("timeLabel", () => {
  const now = new Date(2026, 9, 13, 15, 0);

  it("names today and yesterday", () => {
    expect(timeLabel(at(2026, 10, 13, 9, 5), now)).toBe("Today 09:05");
    expect(timeLabel(at(2026, 10, 12, 23, 59), now)).toBe("Yesterday 23:59");
  });

  it("gives the date for older messages, with the year when it differs", () => {
    expect(timeLabel(at(2026, 10, 2, 18, 20), now)).toBe("2 Oct 18:20");
    expect(timeLabel(at(2025, 12, 31, 8, 0), now)).toBe("31 Dec 2025 08:00");
  });
});

describe("startsTimeGroup", () => {
  it("shows a line for the first message, a new day, or a pause", () => {
    expect(startsTimeGroup(at(2026, 10, 13, 9, 0), undefined)).toBe(true);
    expect(startsTimeGroup(at(2026, 10, 13, 0, 1), at(2026, 10, 12, 23, 58))).toBe(true);
    expect(startsTimeGroup(at(2026, 10, 13, 9, 30), at(2026, 10, 13, 9, 0))).toBe(true);
  });

  it("keeps messages a few minutes apart together", () => {
    expect(startsTimeGroup(at(2026, 10, 13, 9, 4), at(2026, 10, 13, 9, 0))).toBe(false);
  });
});
