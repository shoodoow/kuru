import {
  assertControllable,
  click,
  keyboard,
  mouse,
  pressKey,
  resolveSession,
  screenshotPng,
  clampPoint,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from "../desktop/desktop.js";
import { accountShared, exec, execBytes, execStdin } from "../linux/linux.js";
import { machinePlan } from "../linux/linux.js";
import { inGb, largestGrant } from "../linux/memory-plan.js";
import { expandHome, assertInside } from "./find.js";
import { noted } from "../log/logger.js";

// Why: the agent must work on its assigned desktop — the one the viewer shows
// — never boot a private X server on another display (the blank-viewer
// bug). These patterns catch Xvfb/x11vnc/websockify startups and raw DISPLAY
// overrides smuggled inside bash commands.
const FORBIDDEN_DISPLAY = [
  /\bxvfb\b/i,
  /\bx11vnc\b/i,
  /\bwebsockify\b/i,
  /\bX\s*:[0-9]+\b/,
  /\bDISPLAY\s*=/,
  /\bxrandr\b.*\b--output\b/i,
];

/**
 * Checks a shell command for display-server hijacking.
 * Why: pure and exported for unit tests; rejects private X servers, VNC
 * servers, and DISPLAY overrides so the agent cannot orphan its assigned
 * desktop. Legit GUI apps (chromium, xterm) pass through untouched.
 * Input: the command text. Output: nothing, or throws naming the rule.
 */
export function assertShellSafe(command: string): void {
  for (const pattern of FORBIDDEN_DISPLAY) {
    if (pattern.test(command)) {
      throw new Error(
        "That command touches the display server. Use your assigned desktop (DISPLAY is already set) and the computer tools — do not start Xvfb, x11vnc, or override DISPLAY.",
      );
    }
  }
}

/**
 * Reads a file as the agent.
 * Input: the account id, the Linux username, and an absolute path inside that home or /shared.
 * Output: the file text.
 */
export async function readFile(accountId: string, profile: string, path: string): Promise<string> {
  path = expandHome(accountId, profile, path);
  assertPath(accountId, path, profile);
  const result = await exec(accountId, ["cat", "--", path], profile, undefined, { maxBytes: READ_MAX_BYTES });
  if (result.truncated) {
    return `${result.stdout}\n\n[file cut at ${READ_MAX_BYTES / 1_000_000} MB — read a part of it with head, tail or sed]`;
  }
  if (result.code !== 0) {
    // A directory is a common first guess: answer with its listing instead of
    // an error the model would have to spend another step recovering from.
    if (/is a directory/i.test(result.stdout)) {
      const listing = await exec(accountId, ["ls", "-la", path], profile);
      if (listing.code === 0) return `${path} is a directory:\n${listing.stdout}`;
    }
    throw new Error(result.stdout || "The file could not be read.");
  }
  return result.stdout;
}

/** Most of one file, or of one command's output, the core will hold in memory. */
const READ_MAX_BYTES = 1_000_000;
const BASH_MAX_OUTPUT_BYTES = 1_000_000;
/** A foreground command that runs this long is stopped; long jobs belong in the background. */
const BASH_TIMEOUT_SECONDS = 30 * 60;
/** Exit code coreutils `timeout` uses when it stopped the command. */
const TIMEOUT_EXIT_CODE = 124;

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** True when a path names a picture a vision model can look at. */
export function isImagePath(path: string): boolean {
  return IMAGE_FILE.test(path.trim());
}

/**
 * Loads a picture from the agent's computer, shrunk for a vision model.
 * Why: a worker that renders a video or chart has to see a frame to know it
 * is not blank; `cat` on a PNG is noise. ffmpeg scales it to 960px wide as a
 * JPEG so one look costs about as much as a page of text.
 * Input: account, Linux user, absolute image path. Output: {path, jpegBase64}.
 */
export async function readImage(
  accountId: string,
  profile: string,
  path: string,
): Promise<{ path: string; jpegBase64: string }> {
  path = expandHome(accountId, profile, path);
  assertPath(accountId, path, profile);
  const out = `/tmp/view-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`;
  // Paths travel as arguments, never inside the script text, so no quoting can break.
  const made = await exec(
    accountId,
    ["sh", "-c", `ffmpeg -v error -y -i "$1" -vf "scale='min(960,iw)':-2" -frames:v 1 -q:v 7 "$2" 2>&1`, "sh", path, out],
    profile,
  );
  if (made.code !== 0) throw new Error(made.stdout.slice(0, 300) || "The image could not be opened.");
  const bytes = await execBytes(accountId, ["cat", out], profile);
  await exec(accountId, ["rm", "-f", out], profile).catch(noted("Removing a temporary image"));
  if (bytes.code !== 0 || bytes.stdout.length === 0) throw new Error("The image could not be opened.");
  return { path, jpegBase64: bytes.stdout.toString("base64") };
}

/**
 * Writes a file as the agent.
 * Input: the account id, the Linux username, an absolute path, and the text.
 * Output: nothing. The file is created or replaced.
 */
export async function writeFile(accountId: string, profile: string, path: string, body: string): Promise<void> {
  path = expandHome(accountId, profile, path);
  assertPath(accountId, path, profile);
  // The body goes in on stdin: one argument is capped near 128KB by Linux, so a
  // file passed on the command line failed once it grew past that.
  const result = await execStdin(accountId, ["sh", "-c", 'cat > "$1"', "sh", path], Buffer.from(body), profile);
  if (result.code !== 0) {
    throw new Error(result.stdout.toString("utf8") || "The file could not be written.");
  }
}

/**
 * Runs a shell command as the agent on its assigned desktop.
 * Why: DISPLAY resolves from the same deterministic function the viewer uses,
 * so chromium/xterm always open on the watched screen. Display-server
 * commands are rejected (see assertShellSafe) to prevent viewer mismatch.
 * Input: the account id, the Linux username, and the command text.
 * Output: the command's text.
 */
export async function bash(accountId: string, profile: string, command: string): Promise<string> {
  assertShellSafe(command);
  // Starts the desktop when it is down, so a GUI program launched here has a screen.
  const displayName = `:${(await resolveSession(accountId, profile)).display}`;
  const result = await exec(
    accountId,
    ["timeout", "--kill-after=10", String(BASH_TIMEOUT_SECONDS), "bash", "-lc", command],
    profile,
    [`DISPLAY=${displayName}`],
    { maxBytes: BASH_MAX_OUTPUT_BYTES },
  );
  if (result.truncated) {
    return `${result.stdout}\n\n[output cut at ${BASH_MAX_OUTPUT_BYTES / 1_000_000} MB and the command was stopped — send long output to a file and read part of it]`;
  }
  if (result.code === TIMEOUT_EXIT_CODE) {
    throw new Error(
      `The command ran for ${BASH_TIMEOUT_SECONDS / 60} minutes and was stopped. Start long-running programs in the background (nohup ... &) and check on them later.\n${result.stdout}`.trim(),
    );
  }
  if (result.code !== 0) {
    throw new Error(result.stdout || "The command failed.");
  }
  return result.stdout;
}

/**
 * Takes a grounded PNG screenshot of the agent's own display.
 * Why: thin wrapper so model tools share one path with the same takeover
 * guard and per-screen serialization as mouse/keyboard. Bytes are written to
 * a path the parent can cite; pngBase64 is only for the worker's vision step
 * via toModelOutput (never echoed into the parent report).
 * Input: account id + profile. Output: {path, display, width, height, pngBase64}.
 */
export async function screenshotImage(accountId: string, profile: string) {
  assertControllable(accountId, profile);
  const shot = await screenshotPng(accountId, profile);
  const dir = `${accountShared(accountId)}/screenshots/${profile}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/shot-${stamp}.png`;
  const mkdir = await exec(accountId, ["mkdir", "-p", dir], profile);
  if (mkdir.code !== 0) {
    throw new Error(mkdir.stdout || "Could not create screenshots directory.");
  }
  const written = await execStdin(
    accountId,
    ["sh", "-c", 'cat > "$1"', "sh", path],
    Buffer.from(shot.pngBase64, "base64"),
    profile,
  );
  if (written.code !== 0) {
    throw new Error(written.stdout.toString("utf8").slice(0, 500) || "Could not save screenshot.");
  }
  return {
    path,
    display: shot.display,
    width: shot.width,
    height: shot.height,
    pngBase64: shot.pngBase64,
  };
}

/**
 * Moves the pointer to clamped coordinates on the agent's display.
 * Why: clamping absorbs model coordinate hallucination; guard + lock shared
 * with click/type. Input: account id, profile, x/y. Output: clamped {x, y}.
 */
export async function moveMouse(accountId: string, profile: string, x: number, y: number) {
  assertControllable(accountId, profile);
  return mouse(accountId, profile, x, y);
}

/**
 * Atomically moves and left-clicks so grounding cannot race a screenshot.
 * Input: account id, profile, x/y, optional button. Output: clamped {x, y}.
 */
export async function clickAt(accountId: string, profile: string, x: number, y: number, button = 1) {
  assertControllable(accountId, profile);
  return click(accountId, profile, x, y, button);
}

/**
 * Types text on the agent's display (1-4000 chars per call).
 * Input: account id, profile, text. Output: {typed} character count.
 */
export async function typeText(accountId: string, profile: string, text: string) {
  assertControllable(accountId, profile);
  return keyboard(accountId, profile, text);
}

/**
 * Presses one allowlisted key combo on the agent's display.
 * Input: account id, profile, combo (Return, Escape, ctrl+c...). Output: {key}.
 */
export async function pressKeys(accountId: string, profile: string, combo: string) {
  assertControllable(accountId, profile);
  return pressKey(accountId, profile, combo);
}

function assertPath(accountId: string, path: string, profile: string): void {
  // Single gate lives in find.ts — one definition, no drift between tools.
  assertInside(accountId, profile, path);
}

export { clampPoint, DESKTOP_WIDTH, DESKTOP_HEIGHT };

const FACTS_TTL_MS = 60 * 60 * 1000;
const factsCache = new Map<string, { at: number; text: string }>();

/**
 * One line describing the account computer: CPU, memory, GPU, free disk.
 * Why: without it the agent asks the person "does your computer have a GPU?"
 * about a machine that is its own and that it could have checked. Read once
 * an hour per account, so it costs nothing per turn.
 * Input: account id. Output: the line, or "" when the computer is unreachable.
 */
export async function computerFacts(accountId: string): Promise<string> {
  const cached = factsCache.get(accountId);
  if (cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.text;
  try {
    const probe = await exec(accountId, [
      "sh",
      "-c",
      "echo \"cpu=$(nproc) arch=$(uname -m)\"; " +
        "df -BG --output=avail / | tail -1 | tr -dc '0-9' | sed 's/^/disk_free_gb=/'; echo; " +
        "(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | sed 's/^/gpu=/') || echo gpu=none",
    ]);
    const get = (key: string): string => new RegExp(`${key}=(\\S+)`).exec(probe.stdout)?.[1] ?? "?";
    const gpu = /gpu=(.*)/.exec(probe.stdout)?.[1]?.trim() ?? "none";
    // The memory is this computer's own limit, not the machine's: /proc/meminfo shows the whole machine.
    const { plan } = await machinePlan();
    const text = `Linux, ${get("cpu")} CPU cores (${get("arch")}), ${inGb(plan.baselineBytes)} RAM for everyday work (a worker can borrow up to about ${inGb(largestGrant(plan, 0))} for one heavy job with computer_memory), ${get("disk_free_gb")} GB free disk, ${gpu === "none" ? "no GPU" : `GPU: ${gpu}`}.`;
    factsCache.set(accountId, { at: Date.now(), text });
    return text;
  } catch {
    return "";
  }
}
