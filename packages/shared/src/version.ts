/**
 * The release this code belongs to, and the oldest other side it works with.
 * Why: the server and the phone app are updated separately, by different
 * people at different times. Without a check, an old app on a new server (or
 * the reverse) failed in odd ways with no word about why. Each side now says
 * its version and the other side can ask for an update in plain words.
 * To release: change KURU_VERSION here and "version" in the root package.json
 * together (a test keeps them equal), and add the entry to CHANGELOG.md.
 */

/** This release. Semantic versioning: major.minor.patch. */
export const KURU_VERSION = "0.2.0";

/**
 * The oldest app this server still works with. Raise it in the release that
 * changes or removes something an older app calls.
 */
export const MIN_APP_VERSION = "0.2.0";

/**
 * The oldest server this app still works with. Raise it in the release where
 * the app starts to need something an older server does not have. Nothing
 * does yet, so every server passes.
 */
export const MIN_SERVER_VERSION = "0.0.0";

/** What a server says about itself on GET /health. Older servers send only `ok`. */
export type ServerVersionInfo = { version?: string; minAppVersion?: string };

/**
 * Orders two versions.
 * Input: two "major.minor.patch" strings; missing parts count as 0.
 * Output: below zero when the first is older, zero when equal, above zero when newer.
 */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const first = parts(left);
  const second = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const gap = (first[index] ?? 0) - (second[index] ?? 0);
    if (gap !== 0) return gap;
  }
  return 0;
}

/**
 * Says whether the app and the server it talks to fit together.
 * Input: what the server reported. Output: null when they fit, otherwise one
 * sentence for the person saying which side to update. A server from before
 * versions were reported sends no version and counts as older than any release.
 */
export function versionNotice(server: ServerVersionInfo, appVersion: string = KURU_VERSION): string | null {
  if (server.minAppVersion && compareVersions(appVersion, server.minAppVersion) < 0) {
    return `This app (${appVersion}) is too old for this server, which needs ${server.minAppVersion} or newer. Update the app.`;
  }
  if (compareVersions(server.version ?? "0.0.0", MIN_SERVER_VERSION) < 0) {
    return `This server${server.version ? ` (${server.version})` : ""} is older than this app needs (${MIN_SERVER_VERSION}). Ask whoever runs it to update it.`;
  }
  return null;
}
