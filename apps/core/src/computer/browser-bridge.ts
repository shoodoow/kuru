import { resolveSession, type Session } from "../desktop/desktop.js";
import { sharedDb } from "../db/client.js";
import { exec } from "../linux/linux.js";
import { browserIdleMs, browserUsed, makeRoomForBrowser } from "./housekeeping.js";

/** The browser tools. Names match the agent tool list. */
export const BROWSER_BRIDGE_TOOLS = [
  "browser_list_pages",
  "browser_navigate",
  "browser_snapshot",
  "browser_read",
  "browser_click",
  "browser_click_at",
  "browser_hover",
  "browser_drag",
  "browser_fill",
  "browser_type",
  "browser_check",
  "browser_select",
  "browser_set_value",
  "browser_upload",
  "browser_press_key",
  "browser_scroll",
  "browser_back",
  "browser_reload",
  "browser_tabs",
  "browser_download",
  "browser_eval",
  "browser_handle_dialog",
  "browser_wait_for",
  "browser_screenshot",
] as const;

export type BrowserBridgeTool = (typeof BROWSER_BRIDGE_TOOLS)[number];

const MAX_OUTPUT = 20_000;
/** A page's tree after opening it: enough to act on, without filling the context with a long page. */
const NAVIGATE_SNAPSHOT_CHARS = 8_000;
const SITE_NOTE_CHARS = 2_000;

/**
 * Page script: sets a form field's value directly and tells the page it changed.
 * Why: a date, time, range or colour field is drawn by the browser as several small parts
 * (hours, minutes, AM/PM), and the page tree gives a ref to each part, not to the field.
 * Filling a part reported success and changed nothing, and typing into one put the text in
 * whatever field had focus. The field is found by its name, id or label instead.
 */
function setValueScript(field: string, value: string): string {
  return `(() => {
  const FIELD = ${JSON.stringify(field)}, VALUE = ${JSON.stringify(value)};
  const all = [...document.querySelectorAll("input, select, textarea")];
  const label = (el) => ((el.labels && el.labels[0] ? el.labels[0].innerText : "") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim();
  const want = FIELD.trim().toLowerCase();
  const el = all.find((e) => e.name === FIELD || e.id === FIELD) || all.find((e) => label(e).toLowerCase() === want) || all.find((e) => want && label(e).toLowerCase().startsWith(want));
  if (!el) return "No field called " + JSON.stringify(FIELD) + ". Fields on this page: " + all.filter((e) => e.type !== "hidden").map((e) => (e.name || e.id || label(e)) + " (" + (e.type || e.tagName.toLowerCase()) + ")").join(", ");
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  el.focus();
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, VALUE);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const name = el.name || el.id || label(el);
  if (el.value !== VALUE) {
    const shape = { time: "HH:MM in 24-hour time, such as 13:45", date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", color: "#rrggbb", range: "a number", number: "a number" }[el.type] || "a value this field accepts";
    const limits = [el.min && "min " + el.min, el.max && "max " + el.max, el.step && "step " + el.step].filter(Boolean).join(", ");
    return "The field " + name + " (" + el.type + ") did not take " + JSON.stringify(VALUE) + "; it now holds " + JSON.stringify(el.value) + ". It wants " + shape + (limits ? " (" + limits + ")" : "") + ".";
  }
  return "Set " + name + " to " + JSON.stringify(el.value) + ".";
})()`;
}

/** Page script: the fields that only browser_set_value can fill, with what each holds and accepts. */
const SPECIAL_FIELDS = `(() => {
  const kinds = ["time", "date", "datetime-local", "month", "week", "range", "color"];
  const label = (el) => ((el.labels && el.labels[0] ? el.labels[0].innerText : "") || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
  return [...document.querySelectorAll("input")].filter((e) => kinds.includes(e.type)).slice(0, 20).map((e) => {
    const limits = [e.min && "min " + e.min, e.max && "max " + e.max, e.step && "step " + e.step].filter(Boolean).join(", ");
    return "- " + (e.name || e.id || label(e)) + " (" + e.type + (limits ? ", " + limits : "") + (label(e) ? ', labelled "' + label(e).slice(0, 60) + '"' : "") + ") = " + JSON.stringify(e.value);
  }).join("\\n");
})()`;

/** An element reference from a snapshot, with or without its "@": e12. */
function ref(value: unknown): string {
  const text = String(value ?? "").trim().replace(/^@/, "");
  if (!/^e\d{1,6}$/.test(text)) {
    throw new Error(`"${String(value ?? "").slice(0, 40)}" is not an element reference. Take a browser_snapshot and pass a ref from it, such as e12.`);
  }
  return `@${text}`;
}

/**
 * Turns one browser tool call into agent-browser commands.
 * Why: the model's input is checked here, before anything runs on the
 * computer, and each tool maps to commands whose arguments are passed as
 * separate words, never pasted into a shell line.
 * Input: tool name and args. Output: the agent-browser argument lists to run in order.
 */
export function browserCommands(name: string, args: Record<string, unknown>): string[][] {
  if (!BROWSER_BRIDGE_TOOLS.includes(name as BrowserBridgeTool)) {
    throw new Error(`Unknown browser tool ${name}.`);
  }
  // The page and its address, so the model knows where an action left it.
  // A click may start loading another page: give it a moment to begin, then let it load.
  const where = [["wait", "400"], ["wait", "--load", "domcontentloaded"], ["get", "title"], ["get", "url"]];
  switch (name as BrowserBridgeTool) {
    case "browser_list_pages":
      return [["tab", "list"]];
    case "browser_navigate": {
      const url = new URL(String(args.url ?? ""));
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("browser_navigate only opens http or https URLs.");
      }
      // Not --compact: that drops paragraphs, and with them the text the agent came to read.
      return [["open", url.toString()], ["snapshot", "-u"]];
    }
    case "browser_snapshot":
      return [["snapshot", "-u", ...(args.interactive === true ? ["-i"] : [])]];
    case "browser_read":
      return [["get", "text", args.uid ? ref(args.uid) : "body"]];
    case "browser_click":
      return [[args.double === true ? "dblclick" : "click", ref(args.uid)], ...where];
    case "browser_click_at": {
      // For what has no ref: a canvas, a map, a picture. The pointer travels there first, as a hand would.
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!(x >= 0 && x <= 10_000 && y >= 0 && y <= 10_000)) throw new Error("x and y are pixel positions inside the page, as seen in browser_screenshot.");
      return [["mouse", "move", String(x), String(y)], ["mouse", "down"], ["mouse", "up"], ...where];
    }
    case "browser_hover":
      return [["hover", ref(args.uid)]];
    case "browser_drag":
      return [["drag", ref(args.uid), ref(args.to)]];
    case "browser_type": {
      // Key by key, the way a person types: for fields that react to each key (search suggestions, chat boxes, editors).
      const text = String(args.text ?? "");
      const typed = args.uid ? ["type", ref(args.uid), text] : ["keyboard", "type", text];
      return args.enter === true ? [typed, ["press", "Enter"], ...where] : [typed];
    }
    case "browser_check":
      return [[args.checked === false ? "uncheck" : "check", ref(args.uid)]];
    case "browser_fill":
      return [["fill", ref(args.uid), String(args.value ?? "")]];
    case "browser_select":
      return [["select", ref(args.uid), String(args.value ?? "")]];
    case "browser_set_value":
      return [["eval", setValueScript(String(args.field ?? ""), String(args.value ?? ""))]];
    case "browser_upload": {
      const path = String(args.path ?? "");
      if (!/^(\/home\/[^/]+\/|\/shared\/)/.test(path) || path.includes("..")) {
        throw new Error("browser_upload takes a file path under your home or /shared.");
      }
      return [["upload", ref(args.uid), path]];
    }
    case "browser_press_key":
      return [["press", String(args.key ?? "")], ...where];
    case "browser_scroll": {
      const direction = String(args.direction ?? "down");
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("direction is up, down, left or right.");
      const pixels = Math.min(20_000, Math.max(50, Math.round(Number(args.pixels) || 700)));
      return [["scroll", direction, String(pixels)]];
    }
    case "browser_back":
      return [["back"], ...where];
    case "browser_reload":
      return [["reload"], ...where];
    case "browser_download": {
      const name = String(args.name ?? "").trim();
      if (!/^[\w .()-]{1,120}$/.test(name) || name.startsWith(".")) throw new Error("name is a plain file name, such as report.pdf.");
      return [["download", ref(args.uid), `${String(args.folder ?? "")}/${name}`]];
    }
    case "browser_eval":
      return [["eval", String(args.script ?? "")]];
    case "browser_tabs": {
      const action = String(args.action ?? "list");
      if (action === "list") return [["tab", "list"]];
      if (action === "new") {
        const url = new URL(String(args.url ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A new tab opens an http or https URL.");
        return [["tab", "new", url.toString()], ...where];
      }
      const tab = String(args.tab ?? "").trim();
      if (!/^t?\d{1,4}$/.test(tab)) throw new Error("Pass the tab's id from the list, such as t2.");
      if (action === "switch") return [["tab", tab], ...where];
      if (action === "close") return [["tab", "close", tab], ["tab", "list"]];
      throw new Error("action is list, new, switch or close.");
    }
    case "browser_handle_dialog":
      return [args.accept ? ["dialog", "accept", ...(args.promptText ? [String(args.promptText)] : [])] : ["dialog", "dismiss"]];
    case "browser_wait_for":
      return [["wait", "--text", String(args.text ?? "")]];
    case "browser_screenshot":
      return [["screenshot", String(args.path ?? "")]];
  }
}

/**
 * The shell script that makes sure a visible Chromium with DevTools is running.
 * Why: opening a page used to depend on the model typing a long launch
 * command exactly right. Weak models started a headless browser (the tools
 * answered, the screen stayed empty), launched without the DevTools port, or
 * tripped over a lock left by a crashed browser. This does it the same way
 * every time and says plainly what state the screen is in.
 * Input: display number and DevTools port. Output: script text; it prints one
 * line, `ready`, `started` or `failed: <why>`.
 */
export function ensureBrowserScript(display: number, cdpPort: number): string {
  const launch =
    `setsid nohup chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --start-maximized ` +
    `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} about:blank >/tmp/chromium-${cdpPort}.log 2>&1 &`;
  return [
    `export DISPLAY=:${display}`,
    `version() { curl -s -m 2 http://127.0.0.1:${cdpPort}/json/version 2>/dev/null; }`,
    `alive() { ps -u "$(id -u)" -o stat=,args= 2>/dev/null | grep -v '^Z' | grep -q '[c]hromium'; }`,
    `window() { xdotool search --onlyvisible --class chromium 2>/dev/null | head -1; }`,
    // A window manager that died leaves windows unmanaged and the screen looking broken.
    `if ! pgrep -u "$(id -u)" -x jwm >/dev/null 2>&1 && [ -f /tmp/desktop-${display}/jwmrc ] && command -v jwm >/dev/null; then`,
    `  setsid nohup jwm -f /tmp/desktop-${display}/jwmrc >/tmp/jwm-${display}.log 2>&1 &`,
    `  sleep 0.5`,
    `fi`,
    `v="$(version)"`,
    // Headless answers the tools but shows the person nothing: replace it.
    `if echo "$v" | grep -qi headless; then pkill -u "$(id -u)" -f 'chromium.*--headless' 2>/dev/null; sleep 1; v=""; fi`,
    `if [ -n "$v" ] && [ -n "$(window)" ]; then echo ready; exit 0; fi`,
    `start() {`,
    `  if ! alive; then rm -f "$HOME/.config/chromium/SingletonLock" "$HOME/.config/chromium/SingletonSocket" "$HOME/.config/chromium/SingletonCookie" 2>/dev/null; fi`,
    `  ${launch}`,
    `  for i in $(seq 1 40); do [ -n "$(version)" ] && [ -n "$(window)" ] && return 0; sleep 0.5; done`,
    `  return 1`,
    `}`,
    `if start; then echo started; exit 0; fi`,
    // A browser already open without the DevTools port swallows the launch: close it and start clean.
    `pkill -u "$(id -u)" -f chromium 2>/dev/null; sleep 1; pkill -9 -u "$(id -u)" -f chromium 2>/dev/null; sleep 0.5`,
    `if start; then echo started; exit 0; fi`,
    `echo "failed: $(tail -c 300 /tmp/chromium-${cdpPort}.log 2>/dev/null | tr '\\n' ' ')"`,
    `exit 1`,
  ].join("\n");
}

/**
 * Makes sure this agent's visible browser is up before a browser tool uses it.
 * Input: account id and Linux user. Output: the desktop session it runs on, or throws with the reason.
 */
export async function ensureBrowser(accountId: string, profile: string): Promise<Session> {
  // Chromium needs the desktop up before it can open a window the person can see.
  const session = await resolveSession(accountId, profile);
  // A browser used in the last few minutes is running. One that was not may have to be started,
  // and on a computer short of memory an idle browser of another agent is closed first.
  if (browserIdleMs(accountId, profile) > 5 * 60 * 1000) {
    await makeRoomForBrowser(sharedDb(), accountId, profile).catch(() => undefined);
  }
  browserUsed(accountId, profile);
  const result = await exec(accountId, ["bash", "-lc", ensureBrowserScript(session.display, session.cdpPort)], profile);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.code === 0 && (line === "ready" || line === "started")) return session;
  throw new Error(`The browser did not start on the desktop. ${line.replace(/^failed:\s*/, "").slice(0, 300)}`.trim());
}

/**
 * Opens one page in the visible browser and confirms it is on screen.
 * Why: "open X and hand it to me" should be one dependable call, not a
 * multi-step job a model can get wrong.
 * Input: account id, Linux user, http(s) URL. Output: one plain line about what is showing.
 */
export async function openOnScreen(accountId: string, profile: string, rawUrl: string): Promise<string> {
  const text = rawUrl.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http or https pages can be opened.");
  const reply = await runBrowserTool(accountId, profile, "browser_navigate", { url: url.toString() });
  const session = await resolveSession(accountId, profile);
  const shown = await exec(
    accountId,
    [
      "bash",
      "-lc",
      // The title follows the page a moment after navigation; wait briefly for it to settle.
      `export DISPLAY=:${session.display}; for i in 1 2 3 4 5 6; do id="$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)"; name="$([ -n "$id" ] && xdotool getwindowname "$id" 2>/dev/null)"; case "$name" in ""|about:blank*|"New Tab"*) sleep 0.5;; *) break;; esac; done; [ -n "$id" ] && echo "$name"`,
    ],
    profile,
  );
  const title = shown.stdout.trim().split("\n")[0]?.slice(0, 120) ?? "";
  if (shown.code !== 0 || !title) {
    return `The page was requested (${url.toString()}) but no browser window is visible on the desktop, so the person cannot see it. Browser said: ${reply.slice(0, 300)}`;
  }
  return `Opened ${url.toString()} in the browser on your desktop. The window is on screen, titled "${title}". The person can watch it and take over.`;
}

/**
 * Runs one browser tool on this agent's visible browser.
 * Why: the tools used to be a few hand-written page scripts: a list of the
 * first 80 links with none of the page's text, a click that many sites
 * ignored, a new tab on every visit. They now go through agent-browser, which
 * connects to the same Chromium over its debugging port (127.0.0.1 inside the
 * computer; the core never dials it) and gives real input and a readable page tree.
 * Input: account id, Linux user, tool name, args. Output: the text for the model, capped.
 */
export async function runBrowserTool(
  accountId: string,
  profile: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const commands = browserCommands(name, args);
  // The visible browser is started here when it is not running, so no tool
  // call depends on the model launching Chromium correctly first.
  const { cdpPort } = await ensureBrowser(accountId, profile);
  if (name === "browser_screenshot") {
    await exec(accountId, ["sh", "-c", 'mkdir -p "$(dirname "$1")"', "sh", String(args.path ?? "")], profile).catch(() => undefined);
  }
  if (name === "browser_download") {
    await exec(accountId, ["mkdir", "-p", String(args.folder ?? "")], profile).catch(() => undefined);
  }
  const parts: string[] = [];
  for (const command of commands) {
    const result = await exec(accountId, ["agent-browser", "--cdp", String(cdpPort), ...command], profile, undefined, { timeoutMs: 60_000 });
    const text = result.stdout.trim();
    if (result.code === 127 || /agent-browser: (command )?not found|executable file not found/i.test(text)) {
      return "The browser tools are still being installed on this computer. Try again in a minute; if it still fails, report it under Blockers.";
    }
    if (!text && result.code !== 0) {
      return "The browser is running but did not answer. Try the call once more; if it fails again, report it under Blockers.";
    }
    parts.push(text);
    // A failed step makes the ones after it meaningless: an unknown ref, a page that did not load.
    if (text.startsWith("✗") || result.code !== 0) break;
  }
  let text = parts.join("\n");
  if (name === "browser_navigate") {
    if (text.length > NAVIGATE_SNAPSHOT_CHARS) {
      text = `${text.slice(0, NAVIGATE_SNAPSHOT_CHARS)}\n[The page is longer than this. browser_snapshot shows it all; browser_read gives its text.]`;
    }
    text += await siteNote(accountId, profile, String(args.url ?? ""));
  }
  if (name === "browser_set_value") text = unquote(text);
  if ((name === "browser_navigate" || name === "browser_snapshot") && !text.startsWith("✗")) {
    // Date, time, range and colour fields show in the tree only as their small parts. Name them, so they are set the right way.
    const special = await exec(accountId, ["agent-browser", "--cdp", String(cdpPort), "eval", SPECIAL_FIELDS], profile, undefined, { timeoutMs: 15_000 }).catch(() => null);
    const fields = unquote(special?.stdout.trim() ?? "");
    if (fields.startsWith("- ")) {
      text += `\n\n[Fields on this page that are set with browser_set_value (by the name before the bracket), not with browser_fill or by typing into their parts:\n${fields}]`;
    }
  }
  if (/^✗ Could not locate element/m.test(text)) text += "\nThat element is gone or has changed (a button that turned into another one, a list that redrew). Take a fresh browser_snapshot and use a ref from it.";
  if (/^✗ Unknown ref/m.test(text)) text += "\nThe page changed since your last snapshot. Take a fresh browser_snapshot and use a ref from it.";
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated: browser_snapshot with interactive true is shorter, and browser_read with a ref reads one part]` : text;
}

/** agent-browser prints a script's string result as a JSON string; this gives the text back. */
function unquote(text: string): string {
  if (!text.startsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/** Where an agent keeps what it learned about one website: /shared/notes/sites/<host>.md. */
export function siteNotePath(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,120}$/.test(host) ? `/shared/notes/sites/${host}.md` : null;
  } catch {
    return null;
  }
}

/**
 * What the account's agents wrote down about this site on earlier visits.
 * Why: every job met every site as if for the first time, and worked out
 * again where things are and what gets in the way. A short note per site,
 * shown when the site is opened, carries that over.
 */
async function siteNote(accountId: string, profile: string, rawUrl: string): Promise<string> {
  const path = siteNotePath(rawUrl);
  if (!path) return "";
  const note = await exec(accountId, ["sh", "-c", 'head -c "$2" "$1" 2>/dev/null', "sh", path, String(SITE_NOTE_CHARS)], profile).catch(() => null);
  const text = note?.stdout.trim() ?? "";
  return text
    ? `\n\n[Your notes on this site from earlier visits (${path}). Keep them right: fix what is wrong, add what you learn.]\n${text}`
    : `\n\n[No notes on this site yet. When you learn how it works (where things are, what gets in the way, whether you are signed in), write a few lines to ${path}.]`;
}
