/**
 * Decides when an account computer without an init process needs a restart.
 * Why: computers made before `Init: true` (Oct 14) have `sleep` as their first
 * process, which never collects programs that exit after their parent. Every
 * closed browser leaves several, and once they fill PidsLimit nothing can start:
 * shell, files and browser all fail and workers burn whole runs on errors.
 * Docker cannot add an init to an existing container, and recreating it would
 * delete the agents' homes, so a restart (which keeps every file) is the cure.
 */

/** Programs that run on an idle computer: the desktop, the browser and the first process. */
const BACKGROUND = /^(sleep|Xvfb|x11vnc|websockify|jwm|chromium|chrome.*|agent-browser.*|dbus.*|at-spi.*|pulseaudio|xdg-.*)$/;

export type ReapCheck = { restart: false } | { restart: true; why: string };

/**
 * Input: the live processes' command names (`docker top`, which works even when the
 * computer cannot start a process, but leaves dead ones out), how many process ids
 * the computer holds (Docker stats, dead ones included) and its PidsLimit.
 * Output: whether to restart it now, and why.
 */
export function reapCheck(live: string[], pidsInUse: number, pidsLimit: number): ReapCheck {
  const dead = Math.max(0, pidsInUse - live.length);
  if (dead >= pidsLimit * 0.9) {
    return { restart: true, why: `${dead} dead processes of ${pidsLimit} allowed; nothing new can start` };
  }
  if (dead < pidsLimit * 0.5) return { restart: false };
  if (live.some((command) => !BACKGROUND.test(command))) return { restart: false };
  return { restart: true, why: `${dead} dead processes of ${pidsLimit} allowed and the computer is idle` };
}
