/**
 * Knowing when a provider account is out of money, and acting on it once.
 * Why: when OpenRouter refused for lack of credit, the job failed with the
 * provider's raw text, the agent read it as a passing error and started the
 * job again, and that run failed the same way after paying for its steps.
 * Now the first refusal marks the account, new jobs are not started while
 * it lasts, and the agent is told in words that restarting will not help.
 */

/** How long new work waits after a credit refusal before it is tried again. */
export const CREDIT_OUTAGE_MS = 30 * 60 * 1000;

export class OutOfCreditError extends Error {
  constructor(cause?: unknown) {
    const said = cause instanceof Error ? cause.message.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 240) : "";
    super(
      `OUT OF CREDIT: the model provider refused this job because the account or key has no credit left${said ? ` (it said: ${said})` : ""}. ` +
        "Do not restart this job or start others: they will fail the same way and spend what is left. Tell the person to add credit or raise the key's limit, then continue the job.",
    );
    this.name = "OutOfCreditError";
  }
}

/** True when a provider error means "no money", whatever its wording. */
export function isOutOfCreditError(error: unknown): boolean {
  if (error instanceof OutOfCreditError) return true;
  const status = Number((error as { statusCode?: unknown } | null)?.statusCode);
  if (status === 402) return true;
  const text = error instanceof Error ? `${error.message} ${String((error as { responseBody?: unknown }).responseBody ?? "")}` : String(error);
  return /insufficient (credits|balance|funds)|requires more credits|can only afford|credit limit|out of credits|quota exceeded|billing/i.test(text);
}

const outages = new Map<string, { until: number; provider: string }>();

export function noteCreditOutage(accountId: string, provider: string, now = Date.now()): void {
  outages.set(accountId, { until: now + CREDIT_OUTAGE_MS, provider });
}

/** The account's credit outage, if one is in force. */
export function creditOutage(accountId: string, now = Date.now()): { until: number; provider: string } | null {
  const outage = outages.get(accountId);
  if (!outage) return null;
  if (outage.until <= now) {
    outages.delete(accountId);
    return null;
  }
  return outage;
}

/** Clears the outage (credit was added, or a model call went through). */
export function clearCreditOutage(accountId: string): void {
  outages.delete(accountId);
}
