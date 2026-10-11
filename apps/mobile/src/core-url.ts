import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

declare const process: { env: { EXPO_PUBLIC_CORE_URL?: string } };

const SAVED_KEY = "nano.core-url";
let saved: string | null | undefined;

/**
 * The server this build was made for (apps/mobile/.env → EXPO_PUBLIC_CORE_URL).
 * Tunnel / physical phone: https://api.example.com. Android emulator + local core: http://10.0.2.2:3000.
 */
export function defaultCoreUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.coreUrl;
  const raw = (typeof fromExtra === "string" ? fromExtra : process.env.EXPO_PUBLIC_CORE_URL)?.trim();
  return raw ? raw.replace(/\/$/, "") : "http://127.0.0.1:3000";
}

/** The address the person chose on this phone, or null when they use the build's own. */
export function savedCoreUrl(): string | null {
  if (saved === undefined) {
    try {
      saved = SecureStore.getItem(SAVED_KEY) || null;
    } catch {
      saved = null;
    }
  }
  return saved;
}

/**
 * The server the app talks to right now.
 * Why it is read on every call and not once: the project is open source and
 * people run their own server, so one published build has to work with any of
 * them. The person can change the address on the sign-in screen, and every
 * client follows it without a restart.
 */
export function coreBaseUrl(): string {
  return savedCoreUrl() ?? defaultCoreUrl();
}

/**
 * Cleans up an address the person typed.
 * Input: what they typed ("my.server.com", "https://my.server.com/").
 * Output: the address with a scheme and no trailing slash, or null when it is not a web address.
 */
export function normalizeCoreUrl(input: string): string | null {
  const typed = input.trim();
  if (!typed) return null;
  // A bare host means https, except a local address, which is almost always plain http.
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(typed);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `${local ? "http" : "https"}://${typed}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Remembers the server on this phone, or goes back to the build's own with null.
 * Input: an address already cleaned by `normalizeCoreUrl`, or null.
 */
export function saveCoreUrl(url: string | null): void {
  saved = url && url !== defaultCoreUrl() ? url : null;
  try {
    if (saved) SecureStore.setItem(SAVED_KEY, saved);
    else void SecureStore.deleteItemAsync(SAVED_KEY);
  } catch {
    // The choice still holds until the app is closed.
  }
}
