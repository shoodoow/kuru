/**
 * When each agent last used its desktop or browser.
 * Why: kept apart from the code that closes idle ones, so the desktop and the
 * browser tools can note a use without importing the housekeeping that imports them.
 * DB: none. Lost on a restart, when everything open is taken to have been used just then.
 */
const lastUsed = new Map<string, number>();
const started = Date.now();
const key = (accountId: string, profile: string): string => `${accountId}:${profile}`;

/** Notes that an agent's desktop or browser was just used. */
export function computerUsed(accountId: string, profile: string): void {
  lastUsed.set(key(accountId, profile), Date.now());
}

/** How long since an agent's desktop or browser was used, in milliseconds. */
export function computerIdleMs(accountId: string, profile: string, now = Date.now()): number {
  return now - (lastUsed.get(key(accountId, profile)) ?? started);
}

/** Forgets an agent's last use, after its desktop or browser was closed. */
export function forgetUse(accountId: string, profile: string): void {
  lastUsed.delete(key(accountId, profile));
}
