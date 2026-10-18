import type { ProviderCredit } from "../api";

/** Dollars as the page shows them: cents under $100, whole dollars above. */
export function dollars(value: number): string {
  return value >= 100 ? `$${Math.round(value).toLocaleString()}` : `$${value.toFixed(2)}`;
}

/** One line about a provider's balance, from whatever it publishes. */
export function creditLine(credit: ProviderCredit): string {
  const parts: string[] = [];
  if (credit.balanceUsd !== null) parts.push(`${dollars(credit.balanceUsd)} left on the account`);
  if (credit.keyRemainingUsd !== null && credit.keyLimitUsd !== null) parts.push(`${dollars(credit.keyRemainingUsd)} of the key's ${dollars(credit.keyLimitUsd)} limit left`);
  if (credit.usedTodayUsd !== null) parts.push(`${dollars(credit.usedTodayUsd)} today`);
  if (credit.usedMonthUsd !== null) parts.push(`${dollars(credit.usedMonthUsd)} this month`);
  if (parts.length === 0) return credit.note ?? "No balance available.";
  return parts.join(" · ");
}

/** True when what is left would last less than about a day at today's pace. */
export function runningLow(credit: ProviderCredit): boolean {
  const left = credit.keyRemainingUsd ?? credit.balanceUsd;
  if (left === null) return false;
  return left <= 1 || (credit.usedTodayUsd !== null && credit.usedTodayUsd > 0 && left < credit.usedTodayUsd);
}
