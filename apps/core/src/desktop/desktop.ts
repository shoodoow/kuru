import { computerUsed } from "../computer/activity.js";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { agents } from "../db/schema.js";
import { exec, execBytes } from "../linux/linux.js";

export type Session = { display: number; rfbPort: number; novncPort: number; cdpPort: number };

export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;

/** Linux gives the first agent user id 1000; the first agent desktop is :10. */
const FIRST_UID = 1000;
const FIRST_DISPLAY = 10;
/** Keeps the three port ranges (VNC, noVNC, DevTools) from running into each other. */
const MAX_PROFILES = 990;
/**
 * Bumped whenever the panel or its scripts change, so a desktop that is
 * already running picks the new ones up the next time it is opened.
 */
const DESKTOP_SETUP = "2";
/** How long a desktop that just answered is trusted before it is probed again. */
const READY_TTL_MS = 10_000;

const sessions = new Map<string, Session>();
const readyUntil = new Map<string, number>();
const held = new Set<string>();
// One computer-use task per screen at a time: bots run in
// parallel across profiles, but serialize on their own display so mouse +
// screenshot + type sequences never interleave.
const computerLocks = new Map<string, Promise<void>>();

/**
 * Derives the display and ports for one Linux user id.
 * Why: every agent on an account shares one container, so each needs its own
 * screen. The display used to be a hash of the username into 70 slots, and
 * with ten agents two of them landed on the same screen half the time. A
 * Linux user id is unique inside the container and survives a core restart,
 * so the agent tools, bash DISPLAY, screenshots and the viewer still agree by
 * construction, and no two agents can share a screen.
 * Input: the user id. Output: the display and its VNC, noVNC and DevTools ports.
 */
export function sessionForUid(uid: number): Session {
  const slot = uid - FIRST_UID;
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PROFILES) {
    throw new Error(`Linux user id ${uid} has no desktop slot (this computer holds ${MAX_PROFILES} agent desktops).`);
  }
  const display = FIRST_DISPLAY + slot;
  return { display, rfbPort: 5900 + display, novncPort: 6900 + display, cdpPort: 9200 + display };
}

/**
 * Looks up one profile's display and ports, without starting anything.
 * Input: account id + Linux username. Output: the session. One `id -u` the
 * first time, then remembered until a probe finds the desktop gone.
 */
async function sessionFor(accountId: string, profile: string): Promise<Session> {
  const known = sessions.get(key(accountId, profile));
  if (known) return known;
  const id = await exec(accountId, ["id", "-u", profile]);
  if (id.code !== 0) {
    throw new Error("This agent has no Linux user on the account computer yet.");
  }
  const session = sessionForUid(Number(id.stdout.trim()));
  sessions.set(key(accountId, profile), session);
  return session;
}

/**
 * Starts this profile's virtual display, VNC, and noVNC inside the account Linux.
 * Why: idempotent and deterministic — the display/ports come from
 * sessionForUid() so restarts reconcile to the same :N instead of allocating
 * a new one. A desktop that answered in the last few seconds is trusted
 * without asking again, because every click and keypress comes through here.
 * Otherwise the fast path only probes (owner + xset + novnc port) with zero
 * side effects, because re-running the full setup would warp the pointer back
 * to center and restart VNC under the viewer on every screenshot. Full setup
 * runs solely when the probe fails (fresh desktop or dead server).
 * Input: the account id and the Linux username.
 * Output: the display number and the noVNC port bound on 127.0.0.1 inside the container.
 */
export async function startDesktop(accountId: string, profile: string): Promise<Session> {
  // Every use of the desktop passes here: the screen button, the mouse and keyboard tools, the browser.
  computerUsed(accountId, profile);
  const sessionKey = key(accountId, profile);
  const fresh = sessions.get(sessionKey);
  if (fresh && (readyUntil.get(sessionKey) ?? 0) > Date.now()) {
    return fresh;
  }
  let session = await sessionFor(accountId, profile);
  // Fast reconcile: X alive, owned by this profile, and noVNC listening means
  // viewer, agent tools, and bash DISPLAY already agree — return without
  // touching pointer or servers.
  const probe = await exec(accountId, ["sh", "-c", probeScript(session, profile)]);
  if (probe.code === 0) {
    readyUntil.set(sessionKey, Date.now() + READY_TTL_MS);
    return session;
  }
  // A recreated container hands out user ids afresh, so read this one again.
  sessions.delete(sessionKey);
  readyUntil.delete(sessionKey);
  session = await sessionFor(accountId, profile);
  const { display } = session;
  const root = `/tmp/desktop-${display}`;
  const ready = await exec(accountId, [
    "bash",
    "-lc",
    [
      // A display left running for another profile (an older core numbered
      // displays differently) is shut down, not shared.
      `if [ -f /tmp/.X${display}-lock ] && [ "$(cat ${root}/owner 2>/dev/null)" != ${shellQuote(profile)} ]; then`,
      `  kill $(tr -cd 0-9 < /tmp/.X${display}-lock) 2>/dev/null || true; sleep 0.4`,
      `  rm -f /tmp/.X${display}-lock /tmp/.X11-unix/X${display}`,
      `fi`,
      `if ! xset -display :${display} q >/dev/null 2>&1; then`,
      `  if [ -f /tmp/.X${display}-lock ]; then kill $(tr -cd 0-9 < /tmp/.X${display}-lock) || true; sleep 0.4; fi`,
      `  rm -f /tmp/.X${display}-lock /tmp/.X11-unix/X${display}`,
      `  nohup Xvfb :${display} -screen 0 ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24 -ac >/tmp/xvfb-${display}.log 2>&1 &`,
      `  for i in $(seq 1 50); do xset -display :${display} q >/dev/null 2>&1 && break; sleep 0.1; done`,
      `  xset -display :${display} q >/dev/null`,
      `fi`,
      `mkdir -p ${root}`,
      `printf %s ${shellQuote(profile)} > ${root}/owner`,
      `convert -size 1280x800 gradient:'#3a3a3a-#121212' -fill '#d0d0d0' -draw 'ellipse 640,820 420,280 0,360' ${root}/wallpaper.png`,
      `convert -size 48x48 xc:'#3c4043' -fill '#8ab4f8' -draw 'circle 24,24 24,8' ${root}/chrome.png`,
      `convert -size 48x48 xc:'#3c4043' -fill '#e8eaed' -draw 'rectangle 10,16 38,36' ${root}/files.png`,
      `convert -size 48x48 xc:'#202124' -fill '#e8eaed' -draw 'rectangle 12,22 20,26' -draw 'rectangle 24,22 36,26' ${root}/bash.png`,
      `cat > ${root}/chrome.sh << 'EOF'\n${chromeLauncher(session.cdpPort)}\nEOF`,
      `chmod 755 ${root}/chrome.sh`,
      `cat > ${root}/jwmrc << 'EOF'\n${jwmConfig(display)}\nEOF`,
      `printf %s ${DESKTOP_SETUP} > ${root}/setup`,
      // A panel that is already running reloads its config; open windows stay.
      `su -s /bin/sh ${shellQuote(profile)} -c ${shellQuote(`DISPLAY=:${display} jwm -restart`)} >/dev/null 2>&1 || true`,
      `xsetroot -display :${display} -solid '#1a1a1a' || true`,
      `xsetroot -display :${display} -cursor_name left_ptr || true`,
      `timeout 3 display -window root ${root}/wallpaper.png >${root}/wall.log 2>&1 || true`,
      `echo ${Buffer.from(serveDesktop(display, session.rfbPort, session.novncPort)).toString("base64")} | base64 -d > ${root}/serve.sh`,
      `sh ${root}/serve.sh`,
      `nohup bash -lc ${shellQuote(bootDesktop(display, profile))} >${root}/boot.log 2>&1 &`,
      // The viewer port opens before the screen server behind it; a viewer that
      // connects in between is dropped, so both must be listening.
      `for i in $(seq 1 50); do nc -z 127.0.0.1 ${session.rfbPort} && nc -z 127.0.0.1 ${session.novncPort} && exit 0; sleep 0.1; done`,
      `cat /tmp/xvfb-${display}.log /tmp/vnc-${display}.log /tmp/novnc-${display}.log`,
      "exit 1",
    ].join("\n"),
  ]);
  if (ready.code !== 0) {
    throw new Error(ready.stdout || "The desktop did not start.");
  }
  readyUntil.set(sessionKey, Date.now() + READY_TTL_MS);
  return session;
}

/** Shell test that passes only when this profile's own desktop is up and serving. */
function probeScript(session: Session, profile: string): string {
  return (
    `[ "$(cat /tmp/desktop-${session.display}/owner 2>/dev/null)" = ${shellQuote(profile)} ] && ` +
    `[ "$(cat /tmp/desktop-${session.display}/setup 2>/dev/null)" = ${DESKTOP_SETUP} ] && ` +
    `xset -display :${session.display} q >/dev/null 2>&1 && nc -z 127.0.0.1 ${session.rfbPort} && nc -z 127.0.0.1 ${session.novncPort}`
  );
}

/**
 * Resolves the single source of truth session for a profile.
 * Why: every consumer — agent tools, bash DISPLAY, screenshot, and the noVNC
 * proxy — must agree on the same :N and ports. They come from the profile's
 * Linux user id, so there is no allocation state to lose on restart;
 * startDesktop reconciles the server.
 * Input: account id + profile. Output: session (starts the desktop if needed).
 */
export async function resolveSession(accountId: string, profile: string): Promise<Session> {
  return startDesktop(accountId, profile);
}

/**
 * Throws when the person currently holds the pointer/keyboard.
 * Why: exported so computer tools and model tool wrappers share one guard;
 * the agent must never fight the user for input. Takeover pauses the agent.
 * Input: account id + profile. Output: nothing, or throws "person has the pointer".
 */
export function assertControllable(accountId: string, profile: string): void {
  assertAgent(accountId, profile);
}

/**
 * Serializes computer-use tasks on one screen.
 * Why: one bot runs one computer-use task on its screen at a
 * time, while different bots (profiles) proceed in parallel. Queuing per key
 * keeps mouse→screenshot→type sequences atomic without a global lock.
 * Input: account id, profile, and the async work. Output: the work's result.
 */
export async function withComputerUse<T>(accountId: string, profile: string, work: () => Promise<T>): Promise<T> {
  const lockKey = key(accountId, profile);
  const previous = computerLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  computerLocks.set(lockKey, previous.then(() => current));
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (computerLocks.get(lockKey) === current) computerLocks.delete(lockKey);
  }
}

/**
 * Clamps pixel coordinates to the desktop geometry.
 * Why: models hallucinate out-of-range or fractional coordinates; clamping
 * keeps xdotool from erroring and makes grounding robust. Pure for testing.
 * Input: x/y numbers. Output: integer {x, y} inside 0..WIDTH-1 / 0..HEIGHT-1.
 */
export function clampPoint(x: number, y: number): { x: number; y: number } {
  const cx = Number.isFinite(x) ? Math.round(x) : 0;
  const cy = Number.isFinite(y) ? Math.round(y) : 0;
  return {
    x: Math.max(0, Math.min(DESKTOP_WIDTH - 1, cx)),
    y: Math.max(0, Math.min(DESKTOP_HEIGHT - 1, cy)),
  };
}

/**
 * Captures the profile's display and paints the pointer into the picture.
 * Input: the account id and the Linux username.
 * Output: a PPM image. Two pointer positions produce different bytes.
 */
export async function screenshot(accountId: string, profile: string): Promise<Buffer> {
  const session = await startDesktop(accountId, profile);
  const shot = await execBytes(accountId, ["import", "-window", "root", "ppm:-"], profile, displayEnv(session));
  if (shot.code !== 0) {
    throw new Error(shot.stdout.toString("utf8") || "The screenshot failed.");
  }
  const where = await exec(accountId, ["xdotool", "getmouselocation", "--shell"], profile, displayEnv(session));
  const x = Number(/X=(\d+)/.exec(where.stdout)?.[1] ?? "0");
  const y = Number(/Y=(\d+)/.exec(where.stdout)?.[1] ?? "0");
  return stamp(shot.stdout, x, y);
}

/**
 * Captures a PNG screenshot sized for model input.
 * Why: PPM is unbounded and unreadable to vision models; PNG base64 is what
 * grounded computer-use needs. Runs serialized per screen for consistency.
 * Input: account id + profile. Output: {display, width, height, pngBase64}.
 */
export async function screenshotPng(
  accountId: string,
  profile: string,
): Promise<{ display: string; width: number; height: number; pngBase64: string }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const session = await startDesktop(accountId, profile);
    const shot = await execBytes(
      accountId,
      ["import", "-window", "root", `png:-`],
      profile,
      displayEnv(session),
    );
    if (shot.code !== 0 || shot.stdout.length === 0) {
      throw new Error(shot.stdout.toString("utf8").slice(0, 500) || "The screenshot failed.");
    }
    if (shot.stdout.length > 2_000_000) {
      throw new Error("The screenshot is too large; move the pointer and try a smaller region.");
    }
    return {
      display: `:${session.display}`,
      width: DESKTOP_WIDTH,
      height: DESKTOP_HEIGHT,
      pngBase64: shot.stdout.toString("base64"),
    };
  });
}

/**
 * Moves the pointer on the profile's display.
 * Why: serialized per screen so a move→screenshot grounding pair cannot be
 * split by a concurrent click. Coordinates are clamped to 1280x800.
 * Input: the account id, the Linux username, and pixel coordinates.
 * Output: the clamped {x, y} now holding the pointer.
 */
export async function mouse(accountId: string, profile: string, x: number, y: number): Promise<{ x: number; y: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const at = clampPoint(x, y);
    const session = await startDesktop(accountId, profile);
    const moved = await exec(
      accountId,
      ["xdotool", "mousemove", "--sync", String(at.x), String(at.y)],
      profile,
      displayEnv(session),
    );
    if (moved.code !== 0) {
      throw new Error(moved.stdout || "The pointer did not move.");
    }
    return at;
  });
}

/**
 * Clicks at clamped coordinates (move + left click atomically).
 * Why: separate move/click tool calls race with screenshots; one atomic click
 * keeps grounding accurate. Serialized per screen.
 * Input: account id, profile, x/y, button (1=left default). Output: clamped point.
 */
export async function click(
  accountId: string,
  profile: string,
  x: number,
  y: number,
  button = 1,
  /** Keep the button down this long (ms) before letting go, for a "press and hold" control. */
  holdMs = 0,
): Promise<{ x: number; y: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const at = clampPoint(x, y);
    const session = await startDesktop(accountId, profile);
    const hold = Math.min(30_000, Math.max(0, Math.round(holdMs)));
    // A hold is a real press on the screen: down, wait, up.
    const press = hold > 0 ? ["mousedown", String(button), "sleep", (hold / 1000).toFixed(2), "mouseup", String(button)] : ["click", String(button)];
    const done = await exec(
      accountId,
      ["xdotool", "mousemove", "--sync", String(at.x), String(at.y), ...press],
      profile,
      displayEnv(session),
    );
    if (done.code !== 0) {
      throw new Error(done.stdout || "The click failed.");
    }
    return at;
  });
}

/**
 * Types text on the profile's display.
 * Why: capped at 4k chars per call so a runaway model cannot paste megabytes
 * into the desktop; longer text should use write+paste or multiple calls.
 * Input: the account id, the Linux username, and the text.
 * Output: the number of characters sent.
 */
export async function keyboard(accountId: string, profile: string, text: string): Promise<{ typed: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    if (text.length === 0 || text.length > 4000) {
      throw new Error("Text must be 1-4000 characters.");
    }
    const session = await startDesktop(accountId, profile);
    const typed = await exec(accountId, ["xdotool", "type", "--delay", "0", "--", text], profile, displayEnv(session));
    if (typed.code !== 0) {
      throw new Error(typed.stdout || "The keys were not sent.");
    }
    return { typed: text.length };
  });
}

/**
 * Presses one key combo (e.g. Return, ctrl+c, alt+Tab).
 * Why: typing alone cannot submit forms or switch windows; allowlist keeps
 * the model from sending dangerous combos. Serialized per screen.
 * Input: account id, profile, key string from the allowlist.
 * Output: the key that was sent.
 */
export async function pressKey(accountId: string, profile: string, combo: string): Promise<{ key: string }> {
  const allowed = /^(Return|Escape|Tab|BackSpace|Delete|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|F[0-9]{1,2}|(ctrl|alt|shift)\+[a-zA-Z0-9]+)$/;
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    if (!allowed.test(combo) || combo.length > 32) {
      throw new Error("Unsupported key combo. Use Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x.");
    }
    const session = await startDesktop(accountId, profile);
    const done = await exec(accountId, ["xdotool", "key", "--clearmodifiers", combo], profile, displayEnv(session));
    if (done.code !== 0) {
      throw new Error(done.stdout || "The key was not sent.");
    }
    return { key: combo };
  });
}

/** Forgets that a desktop was up, after it was stopped, so the next use starts it again at once. */
export function forgetDesktop(accountId: string, profile: string): void {
  readyUntil.delete(key(accountId, profile));
}

/** True while the person has taken this agent's mouse. */
export function isHeld(accountId: string, profile: string): boolean {
  return held.has(key(accountId, profile));
}

/**
 * Gives the person the pointer and keyboard.
 * Input: the account id and the Linux username.
 * Output: nothing. Agent mouse and keyboard calls pause until hand-back.
 */
export function takeOver(accountId: string, profile: string): void {
  held.add(key(accountId, profile));
}

/**
 * Returns the pointer and keyboard to the agent.
 * Input: the account id and the Linux username.
 * Output: nothing. Agent mouse and keyboard calls work again.
 */
export function handBack(accountId: string, profile: string): void {
  held.delete(key(accountId, profile));
}

/**
 * Checks that this Linux user belongs to the account.
 * Input: the database, the account id, and the Linux username.
 * Output: true when an agent on that account has this profile.
 */
export async function profileOnAccount(
  store: Store,
  accountId: string,
  profile: string,
): Promise<boolean> {
  const [agent] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), eq(agents.linuxProfile, profile)));
  return Boolean(agent);
}

function assertAgent(accountId: string, profile: string): void {
  if (held.has(key(accountId, profile))) {
    throw new Error("The person has the pointer.");
  }
}

function key(accountId: string, profile: string): string {
  return `${accountId}:${profile}`;
}

function displayEnv(session: Session): string[] {
  return [`DISPLAY=:${session.display}`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function serveDesktop(display: number, rfbPort: number, novncPort: number): string {
  return `#!/bin/sh
if command -v pkill >/dev/null; then
  pkill -f "x11vnc -display :${display}" || true
  pkill -f "websockify 127.0.0.1:${novncPort}" || true
  sleep 0.2
fi
nohup x11vnc -display :${display} -localhost -nopw -cursor arrow -ncache 0 -wait 10 -defer 10 -rfbport ${rfbPort} -forever -shared >/tmp/vnc-${display}.log 2>&1 &
nohup websockify 127.0.0.1:${novncPort} 127.0.0.1:${rfbPort} >/tmp/novnc-${display}.log 2>&1 &
`;
}

function bootDesktop(display: number, profile: string): string {
  const inner = `DISPLAY=:${display} nohup jwm -f /tmp/desktop-${display}/jwmrc >/tmp/jwm-${display}.log 2>&1 & exit 0`;
  return [
    "if ! command -v jwm >/dev/null || ! command -v xterm >/dev/null; then",
    "  for i in 1 2 3 4 5 6 7 8; do",
    "    DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jwm xterm sudo fonts-dejavu-core xfonts-base && break",
    "    sleep 10",
    "  done",
    "fi",
    `su -s /bin/sh ${shellQuote(profile)} -c ${shellQuote(inner)}`,
    "if ! command -v chromium >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium pcmanfm || true; fi",
  ].join("\n");
}

/**
 * The script behind the panel's Chrome button.
 * Why: the button used to start Chrome on every tap. Chrome takes a few
 * seconds to appear, so impatient taps piled up windows, and a tap while
 * Chrome was minimised opened another window instead of bringing it back.
 * Now a tap raises the window if there is one, waits if Chrome is still
 * starting, and starts it only when it is not running.
 */
export function chromeLauncher(cdpPort: number): string {
  return [
    "#!/bin/sh",
    "found=0",
    "for w in $(xdotool search --class chromium 2>/dev/null); do",
    // Chrome owns several helper windows; only its real ones carry this title.
    "  case \"$(xdotool getwindowname \"$w\" 2>/dev/null)\" in",
    "    *Chromium) xdotool windowmap \"$w\" windowactivate \"$w\" 2>/dev/null && found=1 ;;",
    "  esac",
    "done",
    "[ \"$found\" = 1 ] && exit 0",
    // The panel runs as the agent's user, which cannot write beside this script.
    "stamp=/tmp/chrome-starting-$(id -u)",
    "now=$(date +%s)",
    "last=$(cat \"$stamp\" 2>/dev/null || echo 0)",
    "[ $((now - last)) -lt 8 ] && exit 0",
    "echo \"$now\" > \"$stamp\"",
    `exec chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --start-maximized --remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  ].join("\n");
}

export function jwmConfig(display: number): string {
  const root = `/tmp/desktop-${display}`;
  return `<JWM>
<WindowStyle>
<Font>DejaVu Sans-11</Font>
<Width>4</Width>
<Height>24</Height>
<Foreground>#bdbdbd</Foreground><Background>#1a1a1a</Background>
<Active><Foreground>#f2f2f2</Foreground><Background>#3a3a3a</Background></Active>
</WindowStyle>
<Group>
<Class>Chromium</Class>
<Option>maximized</Option>
</Group>
<Desktops width="1" height="1">
<Desktop><Background type="image">${root}/wallpaper.png</Background></Desktop>
</Desktops>
<TaskListStyle>
<Font>DejaVu Sans-11</Font>
<Foreground>#bdbdbd</Foreground><Background>#1a1a1a</Background>
<Active><Foreground>#f2f2f2</Foreground><Background>#3a3a3a</Background></Active>
</TaskListStyle>
<Tray x="0" y="728" height="72">
<TrayButton label="Chrome" icon="${root}/chrome.png">exec:${root}/chrome.sh</TrayButton>
<TrayButton label="Files" icon="${root}/files.png">exec:pcmanfm</TrayButton>
<TrayButton label="Bash" icon="${root}/bash.png">exec:xterm</TrayButton>
<TaskList maxwidth="260"/>
</Tray>
</JWM>`;
}

function stamp(ppm: Buffer, x: number, y: number): Buffer {
  let index = 0;
  const tokens: string[] = [];
  while (tokens.length < 4 && index < ppm.length) {
    while (index < ppm.length && (ppm[index] === 32 || ppm[index] === 10 || ppm[index] === 13 || ppm[index] === 9)) {
      index += 1;
    }
    if (ppm[index] === 35) {
      while (index < ppm.length && ppm[index] !== 10) {
        index += 1;
      }
      continue;
    }
    const start = index;
    while (
      index < ppm.length &&
      ppm[index] !== 32 &&
      ppm[index] !== 10 &&
      ppm[index] !== 13 &&
      ppm[index] !== 9
    ) {
      index += 1;
    }
    tokens.push(ppm.subarray(start, index).toString("ascii"));
  }
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const offset = index + 1;
  const copy = Buffer.from(ppm);
  const px = Math.max(0, Math.min(width - 1, x));
  const py = Math.max(0, Math.min(height - 1, y));
  const at = offset + (py * width + px) * 3;
  copy[at] = 255;
  copy[at + 1] = 0;
  copy[at + 2] = 0;
  return copy;
}
