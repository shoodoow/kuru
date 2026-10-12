import { expoClient, normalizeCookieName } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { activeSlot } from "./account-slots";
import { coreBaseUrl, defaultCoreUrl } from "./core-url";

export { activeSlot, forgetSlot, newSlot, rememberAccount, savedAccounts, useSlot, type SavedAccount } from "./account-slots";

// Required so Android/iOS can close the Chrome tab and return after OAuth deep link.
if (Platform.OS !== "web") {
  WebBrowser.maybeCompleteAuthSession();
}

/** The storage name for one server and slot. Everything that reads or writes a session goes through this. */
function storagePrefix(baseURL: string, slot: string): string {
  const server = baseURL === defaultCoreUrl() ? "kuru" : `kuru-${slug(baseURL)}`;
  return slot ? `${server}-${slot}` : server;
}

/** Where the sign-in for the server and slot in use is kept on the phone. */
export function activeCookieKey(): string {
  return normalizeCookieName(`${storagePrefix(coreBaseUrl(), activeSlot())}_cookie`);
}

function clientFor(baseURL: string, slot: string) {
  return createAuthClient({
    baseURL,
    basePath: "/api/auth",
    plugins: [
      expoClient({
        scheme: "kuru",
        // Each server, and each account on it, keeps its own session on the
        // phone. With one shared place, switching would send one session to
        // another server, or replace one account's sign-in with another's.
        storagePrefix: storagePrefix(baseURL, slot),
        storage: SecureStore,
        webBrowserOptions: { createTask: false },
      }),
    ],
  });
}

type AuthClient = ReturnType<typeof clientFor>;
const clients = new Map<string, AuthClient>();

/** The client for one server and slot, whichever is in use. */
export function authClientFor(server: string, slot: string): AuthClient {
  const key = `${server}|${slot}`;
  let client = clients.get(key);
  if (!client) clients.set(key, (client = clientFor(server, slot)));
  return client;
}

/** A short name for a server address that is safe as a storage key. */
function slug(url: string): string {
  let hash = 0;
  for (const char of url) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 24)}-${hash.toString(36)}`;
}

/**
 * Talks to the server's Better Auth routes.
 * Why a stand-in object: the server and the account in use can both change
 * while the app is open, and the real client is built for one of each. Every
 * use goes to the client for the pair in force at that moment.
 * Output: the Google sign-in client. The session is stored on the phone.
 */
export const authClient: AuthClient = new Proxy({} as AuthClient, {
  get(_target, property) {
    return (authClientFor(coreBaseUrl(), activeSlot()) as unknown as Record<PropertyKey, unknown>)[property];
  },
});
