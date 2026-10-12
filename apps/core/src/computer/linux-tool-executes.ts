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
import { globFiles, grepFiles } from "./find.js";
import { webSearch } from "./search.js";
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
  return {
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
      await writeFile(accountId, profile, String(input.path), String(input.body));
      return "Wrote the file.";
    },
    bash: async (input) => conciseOutput(await bash(accountId, profile, String(input.command))),
    computer_screenshot: async () => {
      screenshots += 1;
      if (screenshots > SCREENSHOT_BUDGET) {
        return (
          `Screenshot budget spent (${SCREENSHOT_BUDGET} this run). Do not shoot again — ` +
          `continue with web_fetch, headless --dump-dom, and the coordinates/descriptions you already have. ` +
          `Only pixels you have not yet seen justify another look, and the camera stays off.`
        );
      }
      return screenshotImage(accountId, profile);
    },
    computer_mouse: async (input) => moveMouse(accountId, profile, Number(input.x), Number(input.y)),
    computer_click: async (input) => clickAt(accountId, profile, Number(input.x), Number(input.y)),
    computer_type: async (input) => typeText(accountId, profile, String(input.text)),
    computer_key: async (input) => pressKeys(accountId, profile, String(input.key)),
    web_fetch: async (input) => {
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
      const fingerprint = query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
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
      const searched = await webSearch(accountId, profile, query, { numResults, braveKey, exaKey });
      if (searched.results.length === 0) {
        consecutiveEmpty += 1;
        const via = searched.fallbackFrom ? `${searched.fallbackFrom} then ${searched.provider}` : searched.provider;
        if (searched.error) return `Search failed (${via}): ${searched.error}`;
        const stopHint =
          consecutiveEmpty >= 2
            ? " Two empty searches in a row — do not reword again. web_fetch the closest URL you have or report partial findings."
            : " If a reword also comes back empty, stop searching: web_fetch the closest URL you have or report partial findings.";
        return `No results (${via}).${stopHint}`;
      }
      consecutiveEmpty = 0;
      const via =
        searched.fallbackFrom != null
          ? `${searched.provider} (fallback after ${searched.fallbackFrom})`
          : searched.provider;
      return [
        `Search via ${via}:`,
        ...searched.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`),
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
    browser_navigate: (input) => runBrowserTool(accountId, profile, "browser_navigate", input),
    browser_snapshot: () => runBrowserTool(accountId, profile, "browser_snapshot", {}),
    browser_click: (input) => runBrowserTool(accountId, profile, "browser_click", input),
    browser_fill: (input) => runBrowserTool(accountId, profile, "browser_fill", input),
    browser_press_key: (input) => runBrowserTool(accountId, profile, "browser_press_key", input),
    browser_handle_dialog: (input) => runBrowserTool(accountId, profile, "browser_handle_dialog", input),
    browser_wait_for: (input) => runBrowserTool(accountId, profile, "browser_wait_for", input),
  };
}

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
