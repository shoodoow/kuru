import type { getDb } from "../db/client.js";
import { toolKeyFor } from "../keys/tools.js";
import {
  bash,
  clickAt,
  isImagePath,
  moveMouse,
  pressKeys,
  readFile,
  readImage,
  screenshotImage,
  typeText,
  writeFile,
} from "./computer.js";
import { expandHome, globFiles, grepFiles } from "./find.js";
import { SEARCH_CATEGORIES, webSearch, type SearchFilters } from "./search.js";
import { webFetch } from "./web.js";
import { openOnScreen, runBrowserTool } from "./browser-bridge.js";
import { memoryStatus, releaseMemory, requestMemory } from "../linux/linux.js";

type Database = ReturnType<typeof getDb>;

/** Parent web_fetch budget: enough for a snippet, not a research dump. */
export const DISPATCHER_FETCH_CHARS = 10_000;
const WORKER_OUTPUT_CHARS = 8_000;

export type LinuxToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Execute bodies for Linux worker tools (schemas live in @kuru/agent-tools).
 * Why: one factory per worker run, so per-run budgets (screenshot cap) reset
 * with the run. Screenshots compound in model context — each one re-bills
 * every later step — so the camera stops after the budget and the worker
 * continues with DOM/text methods instead of burning millions of tokens.
 * Parent cheap tools pass fetchChars so a dispatcher fetch cannot dump a novel.
 */
export function linuxToolExecutes(
  db: Database,
  accountId: string,
  profile: string,
  opts?: {
    fetchChars?: number;
    viewImages?: boolean;
    /** Chat agent: skill files are answered with a pointer to hand the skill on. */
    skillFilesNote?: (path: string) => string;
  },
): Record<string, LinuxToolExecute> {
  // Whether this job has seen the page whole yet; later snapshots are only changes.
  let snapshotted = false;
  /** Pictures this run has looked at. Each one is resent on every later step. */
  let imagesViewed = 0;
  const IMAGE_BUDGET = 8;
  /** Screenshots this worker has taken. Reset per run by construction. */
  let screenshots = 0;
  const SCREENSHOT_BUDGET = 4;
  /**
   * Reword-loop breaker. Reset per run by construction
   */
  const seenQueries = new Map<string, number>();
  let consecutiveEmpty = 0;
  const actions: Record<string, LinuxToolExecute> = {
    computer_memory: async (input) => {
      if (input.action === "release") return releaseMemory(accountId);
      if (input.action === "status") return memoryStatus(accountId);
      if (typeof input.gb !== "number") return { granted: false, note: "Say how much the job needs: gb, a number." };
      return requestMemory(accountId, input.gb, typeof input.minutes === "number" ? input.minutes : undefined);
    },
    read: async (input) => {
      const path = String(input.path);
      if (opts?.skillFilesNote && isSkillPath(path)) return opts.skillFilesNote(path);
      if (opts?.viewImages && isImagePath(path)) {
        imagesViewed += 1;
        if (imagesViewed > IMAGE_BUDGET) {
          return `Image budget spent (${IMAGE_BUDGET} this run). Decide from the pictures you have already seen.`;
        }
        return readImage(accountId, profile, path);
      }
      return conciseOutput(await readFile(accountId, profile, path));
    },
    write: async (input) => {
      const append = input.append === true;
      await writeFile(accountId, profile, String(input.path), String(input.body), append);
      return append ? "Added to the end of the file." : "Wrote the file.";
    },
    bash: async (input) => {
      const command = String(input.command);
      if (drivesBrowserDirectly(command)) return BROWSER_SCRIPT_REFUSAL;
      return conciseOutput(await bash(accountId, profile, command));
    },
    wait: async (input) => waitUntil(accountId, profile, String(input.until), Number(input.minutes) || 15, input.log ? String(input.log) : undefined),
    computer_screenshot: async () => {
      screenshots += 1;
      if (screenshots > SCREENSHOT_BUDGET) {
        return (
          `Screenshot budget spent (${SCREENSHOT_BUDGET} this run). Do not shoot again — ` +
          `continue with browser_snapshot or browser_read for a web page, and the coordinates and descriptions you already have. ` +
          `Only pixels you have not yet seen justify another look, and the camera stays off.`
        );
      }
      return screenshotImage(accountId, profile);
    },
    computer_mouse: async (input) => moveMouse(accountId, profile, Number(input.x), Number(input.y)),
    computer_click: async (input) => clickAt(accountId, profile, Number(input.x), Number(input.y), 1, Number(input.holdMs) || 0),
    computer_type: async (input) => typeText(accountId, profile, String(input.text)),
    computer_key: async (input) => pressKeys(accountId, profile, String(input.key)),
    web_fetch: async (input) => {
      if (isSearchResultsPage(String(input.url))) {
        return "That is a search engine's results page. They answer scripted fetches with a captcha or junk, so this would waste a step. Use web_search; if search is unavailable, see what it said.";
      }
      const parentPeek = opts?.fetchChars != null;
      const page = await webFetch(accountId, profile, String(input.url), parentPeek ? { dispatcherPeek: true } : undefined);
      const byline = [page.siteName, page.byline].filter((part) => part.length > 0).join(" · ");
      const body = [
        `# ${page.title || "(no title)"}${byline ? `\n${byline}` : ""}`,
        `Source: ${page.url}${page.rendered ? " (JS-rendered)" : ""}${page.truncated ? " [truncated]" : ""}`,
        "",
        page.markdown,
      ].join("\n");
      const cap = opts?.fetchChars ?? WORKER_OUTPUT_CHARS;
      if (body.length > cap) {
        return `${body.slice(0, cap)}\n\n[truncated to ${cap} chars — fetch a more specific page or use a focused search]`;
      }
      return body;
    },
    web_search: async (input) => {
      const query = String(input.query);
      const numResults = typeof input.numResults === "number" ? input.numResults : undefined;
      // The same words narrowed another way (other sites, another window) are a new search.
      const narrowed = JSON.stringify([input.sinceDays ?? null, input.sites ?? null, input.category ?? null]);
      const fingerprint = `${query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200)} ${narrowed}`;
      const repeats = (seenQueries.get(fingerprint) ?? 0) + 1;
      seenQueries.set(fingerprint, repeats);
      if (repeats >= 3) {
        return (
          `Same query asked ${repeats} times this run — stop rewording it. ` +
          `web_fetch the best URL you already have, or report partial findings with blockers. ` +
          `Do not call web_search again with the same words.`
        );
      }
      const [braveKey, exaKey] = await Promise.all([
        toolKeyFor(db, accountId, "brave").catch(() => null),
        toolKeyFor(db, accountId, "exa").catch(() => null),
      ]);
      const sites = Array.isArray(input.sites)
        ? input.sites.map((site) => String(site).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()).filter(Boolean)
        : undefined;
      const filters: SearchFilters = {
        ...(typeof input.sinceDays === "number" ? { sinceDays: input.sinceDays } : {}),
        ...(sites && sites.length > 0 ? { sites } : {}),
        ...(typeof input.category === "string" && (SEARCH_CATEGORIES as readonly string[]).includes(input.category)
          ? { category: input.category as SearchFilters["category"] }
          : {}),
      };
      const searched = await webSearch(accountId, profile, query, { numResults, braveKey, exaKey, filters });
      if (searched.results.length === 0) {
        consecutiveEmpty += 1;
        const via = searched.fallbackFrom ? `${searched.fallbackFrom} then ${searched.provider}` : searched.provider;
        if (searched.blocked) return searchUnavailable(searched.error ?? "the search provider refused the request");
        if (searched.error) return `Search failed (${via}): ${searched.error}`;
        const stopHint =
          consecutiveEmpty >= 2
            ? " Two empty searches in a row — do not reword again. web_fetch a page you already know (not a search engine page) or report partial findings."
            : " If a reword also comes back empty, stop searching: web_fetch a page you already know (not a search engine page) or report partial findings.";
        return `No results (${via}).${stopHint}`;
      }
      consecutiveEmpty = 0;
      const via =
        searched.fallbackFrom != null
          ? `${searched.provider} (fallback after ${searched.fallbackFrom})`
          : searched.provider;
      return [
        `Search via ${via}:`,
        ...searched.results.map((row, index) => `${index + 1}. ${row.title}${row.date ? ` (${row.date})` : ""}\n   ${row.url}\n   ${row.snippet}`),
      ].join("\n");
    },
    glob: async (input) => {
      const where = `${typeof input.path === "string" ? input.path : ""} ${String(input.pattern)}`;
      if (opts?.skillFilesNote && isSkillPath(`${where.trim()}/`)) return opts.skillFilesNote(where.trim());
      return globFiles(accountId, profile, String(input.pattern), typeof input.path === "string" ? input.path : undefined);
    },
    grep: async (input) => {
      if (opts?.skillFilesNote && typeof input.path === "string" && isSkillPath(`${input.path}/`)) {
        return opts.skillFilesNote(input.path);
      }
      return grepFiles(accountId, profile, String(input.pattern), {
        path: typeof input.path === "string" ? input.path : undefined,
        include: typeof input.include === "string" ? input.include : undefined,
      });
    },
    open_on_screen: (input) => openOnScreen(accountId, profile, String(input.url)),
    browser_list_pages: () => runBrowserTool(accountId, profile, "browser_list_pages", {}),
    browser_navigate: (input) => {
      snapshotted = true;
      return runBrowserTool(accountId, profile, "browser_navigate", input);
    },
    // The first snapshot this agent takes is whole: another job's last snapshot is no baseline for this one.
    browser_snapshot: (input) => {
      const full = input.full === true || !snapshotted;
      snapshotted = true;
      return runBrowserTool(accountId, profile, "browser_snapshot", { ...input, full });
    },
    browser_read: (input) => runBrowserTool(accountId, profile, "browser_read", input),
    browser_select: (input) => runBrowserTool(accountId, profile, "browser_select", input),
    browser_set_value: (input) => runBrowserTool(accountId, profile, "browser_set_value", input),
    browser_upload: (input) => runBrowserTool(accountId, profile, "browser_upload", { ...input, path: expandHome(accountId, profile, String(input.path ?? "")) }),
    browser_scroll: (input) => runBrowserTool(accountId, profile, "browser_scroll", input),
    browser_back: () => runBrowserTool(accountId, profile, "browser_back", {}),
    browser_reload: () => runBrowserTool(accountId, profile, "browser_reload", {}),
    browser_click_at: (input) => runBrowserTool(accountId, profile, "browser_click_at", input),
    browser_hover: (input) => runBrowserTool(accountId, profile, "browser_hover", input),
    browser_drag: (input) => runBrowserTool(accountId, profile, "browser_drag", input),
    browser_type: (input) => runBrowserTool(accountId, profile, "browser_type", input),
    browser_check: (input) => runBrowserTool(accountId, profile, "browser_check", input),
    browser_download: (input) => runBrowserTool(accountId, profile, "browser_download", { ...input, folder: expandHome(accountId, profile, "~/Downloads") }),
    browser_eval: (input) => runBrowserTool(accountId, profile, "browser_eval", input),
    browser_tabs: (input) => runBrowserTool(accountId, profile, "browser_tabs", input),
    // The picture of the page, shown to the model the way `read` shows an image file.
    browser_screenshot: async (input) => {
      // In the agent's own home: the shared screenshots folder belongs to whichever agent made it first, and the others cannot write there.
      const path = expandHome(accountId, profile, `~/.cache/kuru/page-${Date.now()}.png`);
      const annotate = input.annotate === true;
      const shot = await runBrowserTool(accountId, profile, "browser_screenshot", { path, annotate });
      if (!/saved/i.test(shot)) return shot;
      const image = await readImage(accountId, profile, path);
      // The legend says which ref each number on the picture is.
      const legend = annotate ? shot.split("\n").filter((line) => /\[\d+\]|@e\d+/.test(line)).slice(0, 120).join("\n") : "";
      return legend ? { ...image, note: `Numbers on the picture are refs: [12] is e12.\n${legend}` } : image;
    },
    browser_click: (input) => runBrowserTool(accountId, profile, "browser_click", input),
    browser_fill: (input) => runBrowserTool(accountId, profile, "browser_fill", input),
    browser_press_key: (input) => runBrowserTool(accountId, profile, "browser_press_key", input),
    browser_handle_dialog: (input) => runBrowserTool(accountId, profile, "browser_handle_dialog", input),
    browser_wait_for: (input) => runBrowserTool(accountId, profile, "browser_wait_for", input),
    // Several actions in one call, through the single tools so their checks and fallbacks apply.
    browser_batch: async (input) => {
      const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]).slice(0, 12) : [];
      const lines: string[] = [];
      for (const [index, step] of steps.entries()) {
        const action = String(step.action ?? "");
        const tool = `browser_${action}`;
        const run = actions[tool];
        if (!run || !BATCH_ACTIONS.has(action)) {
          lines.push(`${index + 1}. ${action}: not an action a batch can take.`);
          break;
        }
        let out: string;
        try {
          out = String(await run(step));
        } catch (error) {
          out = `✗ ${error instanceof Error ? error.message : "failed"}`;
        }
        const failed = /^✗|did not take|not an element reference|No field called/m.test(out);
        lines.push(`${index + 1}. ${action}${step.uid ? ` ${String(step.uid)}` : ""}: ${out.split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
        if (failed) {
          lines.push(`Stopped at step ${index + 1}; the steps after it did not run.`);
          break;
        }
      }
      // What the page looks like now, so checking the batch's result costs no extra step.
      // Why: workers followed every batch or click with a snapshot step of its own.
      if (steps.length > 0) {
        const after = await actions.browser_snapshot({}).catch(() => "");
        if (after) lines.push("", "Page now (what changed since your last view):", String(after));
      }
      return lines.join("\n");
    },
  };
  return actions;
}

/**
 * True when a shell command drives the browser itself, around the browser tools:
 * Chrome's debugging port, CDP methods, or a CDP client library.
 * Why: workers wrote a Python websocket script for every step, each 10 to 25
 * seconds and tens of thousands of tokens, chasing a marketing popup as if it
 * were a captcha. The browser tools now cover what pushed them there: covered
 * elements, press and hold, pickers, batches of actions.
 */
export function drivesBrowserDirectly(command: string): boolean {
  const port = /(localhost|127\.0\.0\.1|0\.0\.0\.0):92\d\d\b/.test(command);
  const cdp = /\b(Input\.dispatch(Mouse|Key|Touch)Event|Runtime\.evaluate|DOM\.(querySelector|getDocument)|Page\.navigate)\b/.test(command);
  const client = /\b(connectOverCDP|chrome-remote-interface|puppeteer\.connect|pyppeteer|websocket-client|ws:\/\/[^\s'"]*devtools)\b/i.test(command);
  return client || cdp || (port && /\/json|devtools|websocket/i.test(command));
}

const BROWSER_SCRIPT_REFUSAL =
  "✗ Not run: this drives the browser around the browser tools (its debugging port or CDP). Use the browser_* tools: browser_snapshot to see the page, browser_click (it clicks a covered element with the mouse by itself; holdMs for press and hold), browser_type or browser_batch for fields and pickers, browser_press_key for Escape. A popup, chat bubble or newsletter box over the page is something to close (its ×, or Escape), not a captcha.";

/** The actions browser_batch may run, matching the schema's list. */
const BATCH_ACTIONS = new Set(["click", "click_at", "fill", "type", "select", "check", "set_value", "press_key", "scroll", "hover", "wait_for"]);

/**
 * Bounds one raw text result before it becomes multi-step model history.
 * Why: command/file output is resent on every later model step; retaining a
 * focused prefix and an explicit narrowing instruction keeps context useful
 * without ending the task or imposing a total-token cutoff.
 */
/** True for a path inside an installed skill folder. */
export function isSkillPath(path: string): boolean {
  return /\/(\.agents|\.claude)\/skills(\/|$|\s)/.test(path) || /^\/shared\/skills(\/|$|\s)/.test(path.trim());
}

function conciseOutput(text: string, limit = WORKER_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated to ${limit} chars — rerun with a narrower command, range, or filter]`;
}

/**
 * What a worker is told when search itself is down.
 * Why: told only "no results", workers reworded the query, then fetched
 * Google, Brave, Mojeek and others by hand, met a captcha on each, and spent
 * dozens of full model steps on it. Search pages block scripted requests;
 * only the real browser gets through.
 */
export function searchUnavailable(reason: string): string {
  return [
    `Web search is unavailable right now: ${reason}. Asking again will not help; it stays off for this account for a few minutes.`,
    "Do not fetch search engine pages with web_fetch or curl: they answer scripted requests with a captcha, and each try costs a full step.",
    "Work from addresses you already know or can guess (a company's own site and its /about, /team, /contact pages).",
    "If the job cannot go on without search, one browser_navigate to https://html.duckduckgo.com/html/?q=<words> in the real browser usually works; otherwise report it under Blockers so the person can add a search key.",
  ].join(" ");
}

/** Search result pages of the big engines, which block scripted fetches. */
const SEARCH_PAGES: { host: RegExp; path: RegExp }[] = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/ },
  { host: /(^|\.)bing\.com$/, path: /^\/search/ },
  { host: /^search\.brave\.com$/, path: /^\/search/ },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/(html|lite)?\/?$/ },
  { host: /(^|\.)(mojeek\.com|ecosia\.org|startpage\.com|search\.yahoo\.com|search\.aol\.com|yandex\.[a-z]+)$/, path: /./ },
];

/** True for a URL that is a search engine's results page. */
export function isSearchResultsPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SEARCH_PAGES.some((page) => page.host.test(parsed.hostname) && page.path.test(parsed.pathname) && parsed.search.length > 1);
  } catch {
    return false;
  }
}

/** How often `wait` tries its check. */
const WAIT_EVERY_SECONDS = 10;

/**
 * Waits in one step until a shell check passes or the time is up.
 * Why: a worker waiting on a 7-minute voice-over checked on it with `sleep`,
 * `ps` and `tail` 35 times; each check resent its whole conversation, about
 * 1.5M tokens for nothing. One call now holds until the work is done.
 * Input: account, Linux user, the check, the most minutes to wait, and an
 * optional log file. Output: whether it finished, after how long, and the log's last lines.
 */
export async function waitUntil(accountId: string, profile: string, until: string, minutes: number, log?: string): Promise<string> {
  const limit = Math.min(30, Math.max(1, Math.round(minutes))) * 60;
  const quotedLog = log ? `'${log.replace(/'/g, `'\\''`)}'` : "";
  const script = [
    `start=$(date +%s)`,
    `while :; do`,
    `  if ( ${until} ) >/dev/null 2>&1; then echo "FINISHED $(( $(date +%s) - start ))"; break; fi`,
    `  if [ $(( $(date +%s) - start )) -ge ${limit} ]; then echo "RUNNING ${limit}"; break; fi`,
    `  sleep ${WAIT_EVERY_SECONDS}`,
    `done`,
    ...(log ? [`echo "--- last lines of ${log.replace(/["`$\\]/g, "")}:"`, `tail -n 15 ${quotedLog} 2>&1`] : []),
  ].join("\n");
  const out = await bash(accountId, profile, script);
  const [first, ...rest] = out.split("\n");
  const tail = rest.join("\n").trim();
  const [state, seconds] = (first ?? "").trim().split(" ");
  const took = `${Math.floor(Number(seconds) / 60)}m ${Number(seconds) % 60}s`;
  const head =
    state === "FINISHED"
      ? `Done: the check passed after ${took}.`
      : `Still not done after ${took}. Call wait again if it is still making progress, or look at why it is slow.`;
  return tail ? `${head}\n${tail}` : head;
}
