const path = require("node:path");
const { load } = require("@expo/env");

// Load apps/mobile/.env before Metro inlines EXPO_PUBLIC_* (pnpm filter keeps cwd here).
load(path.resolve(__dirname));

const { expo } = require("./app.json");

// Plain http is only for a core on this machine (emulator or simulator). A
// build pointed at an https core ships with cleartext traffic switched off.
const coreUrl = process.env.EXPO_PUBLIC_CORE_URL ?? "";
// A build for people who run the server on their own network can allow plain
// http for any address with EXPO_PUBLIC_ALLOW_HTTP=1; the person then types
// the address on the sign-in screen.
const usesCleartextTraffic = coreUrl.startsWith("http://") || process.env.EXPO_PUBLIC_ALLOW_HTTP === "1";

/** @type {import("expo/config").ExpoConfig} */
module.exports = {
  expo: {
    ...expo,
    android: { ...expo.android, usesCleartextTraffic },
    extra: {
      ...(expo.extra ?? {}),
      coreUrl: coreUrl || undefined,
    },
  },
};
