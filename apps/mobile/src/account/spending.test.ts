import { describe, expect, it } from "vitest";
import { creditLine, dollars, runningLow } from "./spending";

const credit = { provider: "local", service: "OpenRouter", balanceUsd: null, keyLimitUsd: 50, keyRemainingUsd: 2.1, usedTodayUsd: 31.4, usedMonthUsd: 47.9, note: null };

describe("spending card", () => {
  it("says what is left in one line", () => {
    expect(creditLine(credit)).toBe("$2.10 of the key's $50.00 limit left · $31.40 today · $47.90 this month");
    expect(creditLine({ ...credit, keyLimitUsd: null, keyRemainingUsd: null, usedTodayUsd: null, usedMonthUsd: null, note: "Anthropic does not publish a balance; check its own console." })).toMatch(/does not publish/);
    expect(dollars(1234.5)).toBe("$1,235");
  });

  it("warns when what is left would not last the day", () => {
    expect(runningLow(credit)).toBe(true);
    expect(runningLow({ ...credit, keyRemainingUsd: 40 })).toBe(false);
  });
});
