import { JSDOM, VirtualConsole } from "jsdom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";
import { exec } from "../linux/linux.js";
import { isPrivateHost } from "../net/public-address.js";

/** Suppresses jsdom's noisy "Could not parse CSS stylesheet" on modern pages. */
function quietConsole(): VirtualConsole {
  const console = new VirtualConsole();
  console.on("jsdomError", () => {
    // Stylesheet parse noise from the page; not a failure of the fetch.
  });
  return console;
}

// Why: "go look at this site" is core agent work, but the box ships no curl
// and raw HTML rarely answers anyway. Two tiers: fast static fetch for docs
// and text pages, headless Chromium render for JS-heavy sites (like skill
// directories). Runs INSIDE the account container so egress belongs to the
// tenant, never the core host. Private ranges are refused (SSRF guard).
const STATIC_MAX_BYTES = 500_000;
const TEXT_MAX_CHARS = 15_000;

/**
 * Browser identity for static fetches (proven pattern from opencode's webfetch:
 * a real browser UA + Accept-Language passes bot walls that flag script UAs
 * like curl/wget defaults). The previous `nano-agents/1` (now `kuru/1`) UA was flagged by
 * Cloudflare and JS-heavy marketing pages, turning one cheap fetch into a
 * 300k-token browser worker escalation.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/** Alternate UA for the Cloudflare-challenge retry (opencode retries as "opencode"). */
export const FALLBACK_USER_AGENT = "kuru/1";
const ACCEPT_HEADERS = "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.8,text/plain;q=0.7,*/*;q=0.1";
const ACCEPT_LANGUAGE = "Accept-Language: en-US,en;q=0.9";

/** Extensions that are never page text — refuse before spending render budget. */
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|tar|gz|mp4|mp3|woff2?|ttf|eot)$/i;

export type FetchedPage = {
  url: string;
  title: string;
  byline: string;
  siteName: string;
  markdown: string;
  truncated: boolean;
  rendered: boolean;
};

/**
 * Rejects non-public fetch targets.
 * Why: the container shares a Docker network with the host; loopback,
 * private ranges, link-local (cloud metadata 169.254.169.254), and .local
 * names could reach host services. Pure for testing.
 * Input: raw url string. Output: normalized https/http URL or throws.
 */
export function safeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("That is not a valid URL. Use a full https:// address.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only https:// and http:// pages can be fetched.");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("That address is not fetchable (private or local range).");
  }
  if (raw.length > 2_048) {
    throw new Error("That URL is too long.");
  }
  return parsed.toString();
}

/**
 * Converts a page to LLM-ready Markdown with resolved links.
 * Why: raw HTML buries meaning in nav/chrome markup, and naive tag-stripping
 * destroys the structure models reason over (headings, lists, tables, code).
 * The proven pipeline — Readability extracts the article, Turndown renders it
 * as Markdown — keeps semantics while dropping boilerplate. Non-article
 * pages (homepages, leaderboards) fall back to full-body conversion so
 * nothing real is ever discarded for being unscored.
 * Input: raw html + page url for resolving relatives. Output: title, byline,
 * site, markdown, and whether Reader mode succeeded.
 */
export function htmlToMarkdown(
  html: string,
  pageUrl: string,
): { title: string; byline: string; siteName: string; markdown: string; usedReader: boolean } {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: quietConsole() });
  const document = dom.window.document;
  absolutizeLinks(document, pageUrl);
  stripBoilerplate(document);
  // Readability drops <pre> blocks it deems chrome — yet install commands
  // and snippets are the highest-value bytes for an agent. Lift them out
  // first (stripping the nodes so neither path double-emits), re-attach fenced.
  const codeSamples = collectCodeSamples(document);
  const codeSection =
    codeSamples.length > 0
      ? `\n\n## Code samples\n\n${codeSamples.map((sample) => `\`\`\`${sample.lang}\n${sample.code}\n\`\`\``).join("\n\n")}`
      : "";
  if (isProbablyReaderable(document)) {
    try {
      const article = new Readability(document.cloneNode(true) as Document).parse();
      const textLength = article?.textContent?.trim().length ?? 0;
      if (article?.content && textLength > 200) {
        return {
          title: (article.title ?? "").trim(),
          byline: (article.byline ?? "").trim(),
          siteName: (article.siteName ?? "").trim(),
          markdown: toMarkdown(article.content) + codeSection,
          usedReader: true,
        };
      }
    } catch {
      // Reader choked on this DOM: fall through to full-body conversion.
    }
  }
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  const body = document.body ?? document;
  return { title, byline: "", siteName: "", markdown: toMarkdown(body) + codeSection, usedReader: false };
}

/**
 * Lifts code samples out of the DOM before extraction.
 * Why: Readability silently drops <pre> blocks, and Turndown only fences
 * what survives — either way the agent loses install commands. Collecting
 * upfront (max 10 × 2000 chars) preserves them verbatim with language tags.
 * Input: live document (mutated: pre nodes removed). Output: samples.
 */
function collectCodeSamples(document: Document): { lang: string; code: string }[] {
  const samples: { lang: string; code: string }[] = [];
  for (const pre of document.querySelectorAll("pre")) {
    if (samples.length >= 10) break;
    const code = pre.textContent?.trim() ?? "";
    if (code.length < 2) continue;
    const langMatch = /language-([A-Za-z0-9+-]+)/.exec(pre.querySelector("code")?.className ?? pre.className ?? "");
    samples.push({ lang: langMatch?.[1] ?? "", code: code.slice(0, 2000) });
    pre.remove();
  }
  return samples;
}

/**
 * Removes non-content elements before extraction.
 * Why: embedded JSON blobs (__NEXT_DATA__), scripts, and styles leak through
 * Turndown as text noise — on skills.sh the skill rows drowned in escaped
 * JSON. Reader mode cleans some of this, but the fallback path needs it
 * stripped upfront too.
 * Input: live document (mutated). Output: nothing.
 */
function stripBoilerplate(document: Document): void {
  for (const node of document.querySelectorAll("script, style, noscript, template, header, nav, footer, aside")) {
    node.remove();
  }
  // Embedded JSON blobs (__NEXT_DATA__, hydration state) leak through
  // Turndown as text noise — on skills.sh the rows drowned in escaped JSON.
  for (const node of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__')) {
    node.remove();
  }
}

/** MIME guard (opencode pattern): refuse images/binaries with a clear message instead of garbage. */
export function unsupportedMimeMessage(mime: string): string | null {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!base) return null;
  if (base.startsWith("image/") && base !== "image/svg+xml") {
    return `Unsupported fetched image content type: ${base}. Describe it from the page that links it, or use a browser worker with computer_screenshot.`;
  }
  const textual =
    !base ||
    base.startsWith("text/") ||
    base === "application/json" ||
    base.endsWith("+json") ||
    base === "application/xml" ||
    base.endsWith("+xml") ||
    base === "application/javascript" ||
    base === "application/x-javascript";
  if (!textual) {
    return `Unsupported fetched file content type: ${base}. Do not retry this URL with web_fetch.`;
  }
  return null;
}

/**
 * Renders a DOM subtree as Markdown with absolute link targets.
 * Why: single Turndown configuration (ATX headings, fenced code) so every
 * page reaches the model in one predictable dialect. Input: element or html
 * string. Output: markdown, whitespace-collapsed.
 */
function toMarkdown(root: unknown): string {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const out = service.turndown(root as never);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Resolves relative href/src attributes to absolute https/http URLs in place.
 * Why: Turndown copies hrefs verbatim — a relative "/s/seo" is useless to the
 * model. Non-web schemes (javascript:, mailto:, data:) are unwired so they
 * render as plain text instead of traps.
 * Input: live document + page url. Output: nothing (mutates the DOM).
 */
function absolutizeLinks(document: Document, pageUrl: string): void {
  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      const href = new URL(anchor.getAttribute("href") ?? "", pageUrl).toString();
      if (href.startsWith("https:") || href.startsWith("http:")) {
        anchor.setAttribute("href", href);
      } else {
        anchor.removeAttribute("href");
      }
    } catch {
      anchor.removeAttribute("href");
    }
  }
  for (const image of document.querySelectorAll("img[src]")) {
    try {
      const src = new URL(image.getAttribute("src") ?? "", pageUrl).toString();
      if (src.startsWith("https:") || src.startsWith("http:")) {
        image.setAttribute("src", src);
      } else {
        image.removeAttribute("src");
      }
    } catch {
      image.removeAttribute("src");
    }
  }
}

/**
 * Fetches one public page as grounded text.
 * Why: single entry for the model tool. Static wget first (fast, no
 * browser); when the text is suspiciously thin the page is likely
 * client-rendered, so Chromium headless dumps the live DOM instead.
 * Input: account id, profile (for user-scoped exec), raw url.
 * Output: title, capped text, truncation flag, outlinks, rendered flag.
 */
export type WebFetchOptions = {
  /** Parent turn: static wget first, then one short headless pass if thin (~20s total budget). */
  dispatcherPeek?: boolean;
};

const BOT_WALL_PATTERNS = [
  /just a moment/i,
  /attention required!\s*\|\s*cloudflare/i,
  /why have i been blocked/i,
  /checking your browser before accessing/i,
  /performing security verification/i,
  /cf-browser-verification/i,
  /waiting for .+ to respond/i,
];

/** CDN / bot interstitials look like success but carry no page content. */
export function botWallMessage(text: string): string | null {
  const probe = text.slice(0, 12_000);
  if (!BOT_WALL_PATTERNS.some((re) => re.test(probe))) return null;
  return (
    "Fetched a bot or CDN challenge page, not real content. " +
    "Use spawn_worker with web_fetch (full render) or browser tools; try docs/API URLs instead of marketing homepages."
  );
}

function headlessDumpDomCommand(quoted: string, wallSec: number, navTimeoutMs: number): string {
  return (
    `timeout ${wallSec} chromium --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu ` +
    `--timeout=${navTimeoutMs} --dump-dom ${quoted} 2>/dev/null | head -c ${STATIC_MAX_BYTES}`
  );
}

function wgetCommand(url: string, userAgent: string, timeoutSec: number): string[] {
  const quoted = `'${url.replaceAll("'", `'\\''`)}'`;
  return [
    "sh",
    "-c",
    `wget -qO- --timeout=${timeoutSec} --tries=1 --max-redirect=5 -U '${userAgent}' --header='${ACCEPT_HEADERS}' --header='${ACCEPT_LANGUAGE}' ${quoted} 2>/dev/null | head -c ${STATIC_MAX_BYTES}`,
  ];
}

export async function webFetch(
  accountId: string,
  profile: string,
  rawUrl: string,
  opts?: WebFetchOptions,
): Promise<FetchedPage> {
  const url = safeUrl(rawUrl);
  if (BINARY_EXTENSIONS.test(new URL(url).pathname)) {
    throw new Error(`That URL looks like a file, not a page. Do not retry it with web_fetch.`);
  }
  const quoted = `'${url.replaceAll("'", `'\\''`)}'`;
  const peek = opts?.dispatcherPeek === true;
  const wgetTimeoutSec = peek ? 8 : 20;
  const staticResult = await exec(accountId, wgetCommand(url, BROWSER_USER_AGENT, wgetTimeoutSec), profile);
  let html = staticResult.stdout;
  let rendered = false;
  if (html.trim().length < 500) {
    // Real --timeout wait, not virtual-time: virtual budgets freeze network
    // fetches, so client-rendered rows (skill leaderboards) never hydrate.
    // Proven against skills.sh: rows appear only with a genuine wait.
    const dom = await exec(
      accountId,
      ["sh", "-c", headlessDumpDomCommand(quoted, peek ? 12 : 60, peek ? 10_000 : 30_000)],
      profile,
    );
    if (dom.stdout.trim().length > html.trim().length) {
      html = dom.stdout;
      rendered = true;
    }
  }
  if (html.trim().length === 0) {
    throw new Error(
      peek
        ? "No readable text from a quick parent fetch (JS-heavy site, bot block, or login). spawn_worker with web_fetch for a full render."
        : "The page came back empty. It may block bots, need a login, or be unreachable from the computer.",
    );
  }
  let parsed = htmlToMarkdown(html, url);
  let wall = botWallMessage(`${parsed.title}\n${parsed.markdown}`);
  if (wall) {
    // Cloudflare-challenge retry under an alternate UA before escalating to a
    // worker (opencode pattern: retry as a different client; only escalate if
    // both identities are walled). A worker escalation costs ~300k tokens.
    const retry = await exec(accountId, wgetCommand(url, FALLBACK_USER_AGENT, wgetTimeoutSec), profile);
    if (retry.stdout.trim().length > 0) {
      const retryParsed = htmlToMarkdown(retry.stdout, url);
      if (!botWallMessage(`${retryParsed.title}\n${retryParsed.markdown}`)) {
        parsed = retryParsed;
        wall = null;
      }
    }
  }
  if (wall) throw new Error(wall);
  const truncated = parsed.markdown.length > TEXT_MAX_CHARS;
  return {
    url,
    title: parsed.title,
    byline: parsed.byline,
    siteName: parsed.siteName,
    markdown: truncated ? `${parsed.markdown.slice(0, TEXT_MAX_CHARS)}\n\n[truncated — fetch a linked sub-page for more]` : parsed.markdown,
    truncated,
    rendered,
  };
}
