import { desktopApp } from "./desktop-app";

/**
 * Desktop notifications for the web app and the desktop app around it.
 * Why: on a phone a push banner says an agent answered. A computer gets no
 * push, and the app is often behind other windows, so the app shows the
 * system's own notification for the same messages the phone is pushed.
 */


/** True in a browser that can show system notifications. */
function supported(): boolean {
  return process.env.EXPO_OS === "web" && typeof globalThis.Notification === "function";
}

/** Asks once for permission to notify. The desktop app always has it. */
export function askToNotify(): void {
  if (!supported() || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/** True when the person is looking at the app right now. */
export function appInView(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Shows one system notification. Clicking it brings the app forward and runs onOpen.
 * Input: title, body, a tag (one notification per tag; a newer one replaces it), and onOpen.
 */
export function showNotification(input: { title: string; body: string; tag: string }, onOpen: () => void): void {
  if (!supported() || Notification.permission !== "granted") return;
  const note = new Notification(input.title, { body: input.body.slice(0, 240), tag: input.tag });
  note.onclick = () => {
    desktopApp()?.focus?.();
    globalThis.focus?.();
    onOpen();
    note.close();
  };
}

/** The unread count on the Dock or taskbar icon (desktop app only). */
export function setBadge(count: number): void {
  desktopApp()?.setBadge?.(count);
}
