import * as SecureStore from "./store";

/**
 * One signed-in account kept on this phone.
 * Why slots: the sign-in library keeps one session per storage name. Giving
 * every account its own name lets several stay signed in at once, so switching
 * between them is instant and never asks Google again. `slot` is "" for the
 * account signed in before slots existed.
 */
export type SavedAccount = { slot: string; server: string; id: string; name: string; email: string; image?: string | null };

const ACCOUNTS_KEY = "nano.accounts";
const ACTIVE_KEY = "nano.active-slot";
/** The secure store holds about 2 KB per value, which is room for this many accounts. */
const MAX_ACCOUNTS = 5;
let accounts: SavedAccount[] | undefined;
let active: string | undefined;

function read(key: string): string {
  try {
    return SecureStore.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    SecureStore.setItem(key, value);
  } catch {
    // Kept in memory until the app closes.
  }
}

/** The accounts signed in on this phone, across every server. */
export function savedAccounts(): SavedAccount[] {
  if (!accounts) {
    try {
      const parsed = JSON.parse(read(ACCOUNTS_KEY) || "[]") as unknown;
      accounts = Array.isArray(parsed) ? (parsed as SavedAccount[]).filter((row) => typeof row?.id === "string" && typeof row?.slot === "string") : [];
    } catch {
      accounts = [];
    }
  }
  return accounts;
}

/** The slot whose session the app is using. */
export function activeSlot(): string {
  if (active === undefined) active = read(ACTIVE_KEY);
  return active;
}

/** Makes a slot the one in use. The caller points the app at that slot's server first. */
export function selectSlot(slot: string): void {
  active = slot;
  write(ACTIVE_KEY, slot);
}

/** A name for a slot nobody has used yet. */
export function newSlot(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Records who is signed in on the slot in use.
 * The same account signed in twice keeps only the newest slot; the older one is returned so its session can be ended.
 */
export function rememberAccount(entry: SavedAccount): SavedAccount[] {
  const all = savedAccounts();
  const replaced = all.filter((row) => row.slot !== entry.slot && row.id === entry.id && row.server === entry.server);
  accounts = [entry, ...all.filter((row) => row.slot !== entry.slot && !replaced.includes(row))].slice(0, MAX_ACCOUNTS);
  write(ACCOUNTS_KEY, JSON.stringify(accounts));
  return replaced;
}

/** Takes a slot off the list. Its session is ended by the caller. */
export function forgetSlot(slot: string): void {
  accounts = savedAccounts().filter((row) => row.slot !== slot);
  write(ACCOUNTS_KEY, JSON.stringify(accounts));
}
