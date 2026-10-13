/**
 * Keeps an account's computer lean: closes the browsers and desktops nobody is using.
 * Why: every agent that used its browser kept a Chromium open for good. An
 * account with several agents filled its computer's memory, and the newest
 * browser then crashed and was restarted on every call, taking the whole
 * machine's CPU. A browser is closed after an hour without use, or sooner
 * when another agent needs the memory. Sign-ins live in the browser's profile
 * on disk, so the next call opens it signed in as before.
 * DB: reads delegations to see whether an agent has work running.
 */
import { and, eq, gt, or } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, delegations } from "../db/schema.js";
import { forgetDesktop, isHeld } from "../desktop/desktop.js";
import { computerIdleMs, computerUsed, forgetUse } from "./activity.js";
import { accountMemoryUse, exec, runningAccountIds } from "../linux/linux.js";
import { logger, noted } from "../log/logger.js";

type Db = ReturnType<typeof getDb>;

/** A browser unused for this long is closed. */
export const BROWSER_IDLE_MS = 60 * 60 * 1000;
/** How often every computer is looked at. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;
/** Above this share of its memory limit, a computer gives up an idle browser before starting another. */
export const MEMORY_TIGHT = 0.75;
/** Under memory pressure a browser counts as idle after this long: long enough that no call is in flight. */
const PRESSURE_IDLE_MS = 2 * 60 * 1000;

const key = (accountId: string, profile: string): string => `${accountId}:${profile}`;
const watching = new Map<string, number>();

/** Notes that an agent's browser was just used. */
export const browserUsed = computerUsed;

/** How long since an agent's desktop or browser was used, in milliseconds. */
export const browserIdleMs = computerIdleMs;

/** The person opened this agent's screen in the app. Returns the call that marks it closed again. */
export function screenOpened(accountId: string, profile: string): () => void {
  const id = key(accountId, profile);
  watching.set(id, (watching.get(id) ?? 0) + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const left = (watching.get(id) ?? 1) - 1;
    if (left > 0) watching.set(id, left);
    else watching.delete(id);
  };
}

/** True while the person has this agent's screen open or has taken its mouse. */
export function isWatched(accountId: string, profile: string): boolean {
  return (watching.get(key(accountId, profile)) ?? 0) > 0 || isHeld(accountId, profile);
}

/** The Linux users on this computer that have a browser running. */
export async function browsersOpen(accountId: string): Promise<string[]> {
  // Dead entries (state Z) are not browsers; `user:40` keeps a long user name from being cut short.
  const listed = await exec(accountId, ["sh", "-c", "ps -eo user:40,stat,comm | awk '$3 == \"chromium\" && $2 !~ /^Z/ { print $1 }' | sort -u"]);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
}

/** Closes one agent's browser: asked first, so it saves its state, then stopped. */
export async function closeBrowser(accountId: string, profile: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) return;
  await exec(accountId, [
    "sh",
    "-c",
    // The agent-browser helper holds a connection to the browser that is going away; it starts again on the next call.
    'pkill -TERM -u "$1" -x chromium; for i in 1 2 3 4 5 6; do pgrep -u "$1" -x chromium >/dev/null || break; sleep 0.5; done; pkill -KILL -u "$1" -x chromium; pkill -u "$1" -f agent-browser; true',
    "sh",
    profile,
  ]);
  forgetUse(accountId, profile);
}

/** The Linux users on this computer whose desktop (virtual screen and viewer) is running. */
export async function desktopsOpen(accountId: string): Promise<string[]> {
  // Each desktop writes its owner beside its files; a screen with no live Xvfb is not counted.
  const listed = await exec(accountId, [
    "sh",
    "-c",
    'for d in /tmp/desktop-*/; do n="${d#/tmp/desktop-}"; n="${n%/}"; pgrep -f "^Xvfb :$n " >/dev/null 2>&1 && cat "$d/owner" 2>/dev/null && echo; done | sort -u',
  ]);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
}

/**
 * Stops one agent's desktop: its virtual screen, the viewer behind the app's screen button, and its window manager.
 * It holds about 150 MB while idle and starts again by itself the next time it is needed.
 */
export async function closeDesktop(accountId: string, profile: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) return;
  await closeBrowser(accountId, profile);
  await exec(accountId, [
    "sh",
    "-c",
    // The display number follows from the user id, the same way the desktop code works it out.
    'id -u "$1" >/dev/null 2>&1 || exit 0; d=$(( $(id -u "$1") - 1000 + 10 )); pkill -u "$1" -x jwm; pkill -u "$1" -x xterm; pkill -f "x11vnc -display :$d "; pkill -f "websockify 127.0.0.1:$((6900 + d)) "; pkill -f "^Xvfb :$d "; true',
    "sh",
    profile,
  ]);
  forgetDesktop(accountId, profile);
}

/**
 * Stops the desktops on one computer that nobody is using, longest idle first.
 * Same rules as for browsers: one being watched, or whose agent has work running, is left alone.
 * Output: the Linux users whose desktop was stopped.
 */
export async function closeIdleDesktops(db: Db, accountId: string, options: { idleMs: number; except?: string }): Promise<string[]> {
  const open = (await desktopsOpen(accountId))
    .filter((profile) => profile !== options.except && computerIdleMs(accountId, profile) >= options.idleMs)
    .sort((left, right) => computerIdleMs(accountId, right) - computerIdleMs(accountId, left));
  const closed: string[] = [];
  for (const profile of open) {
    if (isWatched(accountId, profile)) continue;
    if (await hasRunningWork(db, accountId, profile)) continue;
    await closeDesktop(accountId, profile);
    closed.push(profile);
  }
  if (closed.length > 0) logger.info({ accountId, closed }, "Stopped idle desktops on an account computer.");
  return closed;
}

/** True while this agent, or a worker of its, has work running on the computer. */
async function hasRunningWork(db: Db, accountId: string, profile: string): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), eq(agents.linuxProfile, profile)));
  // A browser with no agent behind it (a deleted agent) is nobody's.
  if (!agent) return false;
  const running = await db
    .select({ id: delegations.id })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.status, "running"),
        or(eq(delegations.parentAgentId, agent.id), eq(delegations.childAgentId, agent.id)),
        gt(delegations.heartbeatAt, new Date(Date.now() - 4 * 60 * 60 * 1000)),
      ),
    )
    .limit(1);
  return running.length > 0;
}

/**
 * Closes the browsers on one computer that have gone unused, longest idle first.
 * A browser the person is looking at, or whose agent has work running, is left alone.
 * Input: database, account id, how long counts as idle, a user to leave alone, and how many to close at most.
 * Output: the Linux users whose browser was closed.
 */
export async function closeIdleBrowsers(
  db: Db,
  accountId: string,
  options: { idleMs: number; except?: string; limit?: number },
): Promise<string[]> {
  const open = (await browsersOpen(accountId))
    .filter((profile) => profile !== options.except)
    .map((profile) => ({ profile, idle: browserIdleMs(accountId, profile) }))
    .filter((row) => row.idle >= options.idleMs)
    .sort((left, right) => right.idle - left.idle);
  const closed: string[] = [];
  for (const { profile } of open) {
    if (closed.length >= (options.limit ?? Number.MAX_SAFE_INTEGER)) break;
    if (isWatched(accountId, profile)) continue;
    if (await hasRunningWork(db, accountId, profile)) continue;
    await closeBrowser(accountId, profile);
    closed.push(profile);
  }
  if (closed.length > 0) logger.info({ accountId, closed }, "Closed idle browsers on an account computer.");
  return closed;
}

/**
 * Makes room before an agent's browser is started on a computer short of memory.
 * Input: database, account id, and the user about to start a browser. Output: nothing.
 */
export async function makeRoomForBrowser(db: Db, accountId: string, profile: string): Promise<void> {
  const use = await accountMemoryUse(accountId).catch(() => null);
  if (!use || use.limitBytes <= 0 || use.usedBytes / use.limitBytes < MEMORY_TIGHT) return;
  // Idle desktops first: each holds about 150 MB whether or not anything is on it, and they take their browser with them.
  const stopped = await closeIdleDesktops(db, accountId, { idleMs: PRESSURE_IDLE_MS, except: profile });
  if (stopped.length === 0) await closeIdleBrowsers(db, accountId, { idleMs: PRESSURE_IDLE_MS, except: profile, limit: 1 });
}

/** Looks at every running computer every few minutes. Returns the call that stops it. */
export function startHousekeeping(db: Db): () => void {
  const sweep = async (): Promise<void> => {
    for (const accountId of await runningAccountIds()) {
      // The desktop goes with its browser: an agent idle for an hour needs neither.
      await closeIdleDesktops(db, accountId, { idleMs: BROWSER_IDLE_MS }).catch(noted("Stopping idle desktops"));
      await closeIdleBrowsers(db, accountId, { idleMs: BROWSER_IDLE_MS }).catch(noted("Closing idle browsers"));
    }
  };
  const timer = setInterval(() => void sweep().catch(noted("Looking over the account computers")), SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
