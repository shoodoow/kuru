import { accountHome, accountShared, exec } from "../linux/linux.js";

const MAX_HITS = 100;
const FIND_TIMEOUT = 20;

/**
 * Checks a path stays inside the agent's home or /shared.
 * Why: exported so glob/grep share one gate with read/write — traversal and
 * absolute escapes fail the same way everywhere. Pure for tests.
 * Input: account id, profile, absolute path. Output: nothing, or throws.
 */
/**
 * Expands a leading "~" to the agent's home.
 * Why: models write "~/work" as naturally as people do; rejecting it cost a step each time.
 */
export function expandHome(accountId: string, profile: string, path: string): string {
  const home = accountHome(accountId, profile);
  const clean = path.trim();
  if (clean === "~") return home;
  return clean.startsWith("~/") ? `${home}/${clean.slice(2)}` : clean;
}

export function assertInside(accountId: string, profile: string, path: string): void {
  const home = accountHome(accountId, profile);
  const shared = accountShared(accountId);
  const parts = path.split("/");
  // /tmp too: the shell reaches it as the same user anyway, and a toolkit cloned there
  // was otherwise changed only with sed and cat.
  const inside =
    path === home || path.startsWith(`${home}/`) || path === shared || path.startsWith(`${shared}/`) || path.startsWith("/tmp/");
  if (!path.startsWith("/") || parts.includes("..") || !inside) {
    throw new Error(
      `Path is outside the home, /shared and /tmp. Use an absolute path under ${home}, ${shared} or /tmp; glob finds a file when you only know its name.`,
    );
  }
}

/**
 * Lists files matching a glob under the agent's home or /shared.
 * Why: opencode's glob pattern — structured file discovery beats `find`
 * one-liners the model half-remembers. find -path with a capped head keeps
 * giant trees (node_modules) from flooding the prompt.
 * Input: account, profile, glob like star-star/.ts, optional root dir. Output: paths (<=100).
 */
export async function globFiles(accountId: string, profile: string, pattern: string, root?: string): Promise<string[]> {
  const clean = pattern.trim().slice(0, 200);
  if (!clean || clean.includes("'") || clean.includes("..")) {
    throw new Error("A safe glob pattern is required (no quotes or ..).");
  }
  const split = splitAbsoluteGlob(expandHome(accountId, profile, clean));
  const base = split?.base ?? expandHome(accountId, profile, root?.trim() || accountHome(accountId, profile));
  const rest = split?.rest ?? clean.replace(/^\//, "");
  // find's star crosses folders, so "*" alone listed a whole tree. Without a
  // star-star the pattern names a fixed depth; hold find to it.
  const depth = rest.includes("**") ? "" : `-maxdepth ${rest.split("/").length} `;
  assertInside(accountId, profile, base);
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  // Dependency and VCS trees drown real hits unless the pattern asks for them.
  const prune = /node_modules|\.git/.test(clean)
    ? ""
    : `\\( -name node_modules -o -name .git \\) -prune -o `;
  const result = await exec(
    accountId,
    [
      "sh",
      "-c",
      `timeout ${FIND_TIMEOUT} find ${quoted(base)} ${depth}${prune}\\( ${globAlternatives(rest)
        .map((alt) => `-path ${quoted(`${base}/${alt}`)}`)
        .join(" -o ")} \\) -print 2>/dev/null | head -n ${MAX_HITS}`,
    ],
    profile,
  );
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Rewrites one glob into the plain patterns `find -path` understands.
 * Why: find has no brace sets, and its star-star needs a directory in
 * between, so "star-star/a.{mp4,mov}" silently matched nothing.
 * Input: a glob relative to the search root. Output: 1-16 find patterns.
 */
export function globAlternatives(rest: string): string[] {
  const brace = /\{([^{}]+)\}/.exec(rest);
  const expanded = brace
    ? brace[1]!.split(",").map((option) => rest.replace(brace[0], option.trim()))
    : [rest];
  const out = new Set<string>();
  for (const item of expanded.slice(0, 8)) {
    out.add(item);
    if (item.startsWith("**/")) out.add(item.slice(3));
  }
  return [...out];
}

/**
 * Splits an absolute glob into its literal directory and the wildcard rest.
 * Why: models write the whole path into `pattern` ("/shared/x/star-star/a.html").
 * Searching that under the home matched nothing, so real files looked missing.
 * Input: a glob. Output: {base, rest}, or null when the glob is relative.
 */
export function splitAbsoluteGlob(pattern: string): { base: string; rest: string } | null {
  if (!pattern.startsWith("/")) return null;
  const parts = pattern.split("/").slice(1);
  const firstWild = parts.findIndex((part) => /[*?[\]{}]/.test(part));
  const literal = firstWild < 0 ? parts.slice(0, -1) : parts.slice(0, firstWild);
  const rest = firstWild < 0 ? parts.slice(-1) : parts.slice(firstWild);
  if (literal.length === 0) return null;
  return { base: `/${literal.join("/")}`, rest: rest.join("/") || "*" };
}

/**
 * Searches file contents for a regex, capped and binary-safe.
 * Why: opencode's grep pattern — filename:line hits with a snippet each,
 * timeout-guarded and binary-skipped so a huge tree cannot stall the turn.
 * Input: account, profile, regex, optional dir + glob filter. Output: hits (<=100).
 */
export async function grepFiles(
  accountId: string,
  profile: string,
  pattern: string,
  input: { path?: string; include?: string } = {},
): Promise<{ file: string; line: number; text: string }[]> {
  const clean = pattern.trim().slice(0, 200);
  if (!clean) throw new Error("A search pattern is required.");
  const base = expandHome(accountId, profile, input.path?.trim() || accountHome(accountId, profile));
  assertInside(accountId, profile, base);
  if (input.include && (input.include.includes("'") || input.include.includes(".."))) {
    throw new Error("The include filter is unsafe.");
  }
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const include = input.include?.trim() ? `--include=${quoted(input.include.trim())}` : "";
  const result = await exec(
    accountId,
    ["sh", "-c", `timeout ${FIND_TIMEOUT} grep -rnI -E ${quoted(clean)} ${include} ${quoted(base)} 2>/dev/null | head -n ${MAX_HITS}`],
    profile,
  );
  const out: { file: string; line: number; text: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    out.push({ file: match[1]!, line: Number(match[2]), text: match[3]!.slice(0, 300) });
  }
  return out;
}
