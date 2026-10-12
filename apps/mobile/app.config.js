const fs = require("node:fs");
const path = require("node:path");

// Load apps/mobile/.env with Node itself. @expo/env is only a transitive
// dependency, so pnpm does not expose it when EAS evaluates this file.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

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
      eas: {
        projectId: "47834947-adeb-4aa2-b980-bc72ac43be47",
      },
    },
  },
};
