/**
 * What the Mac and Windows app adds to the page (apps/desktop/src/preload.cjs).
 * Null in a plain browser and on a phone.
 */
export type DesktopApp = {
  /** Signs in with Google in the person's own browser; the app reloads signed in. */
  signIn?: () => Promise<void>;
  setBadge?: (count: number) => void;
  focus?: () => void;
};

export function desktopApp(): DesktopApp | null {
  return (globalThis as { kuruDesktop?: DesktopApp }).kuruDesktop ?? null;
}
