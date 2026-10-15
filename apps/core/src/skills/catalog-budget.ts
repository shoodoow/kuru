/**
 * Fits the skill list into a token budget that scales with the model.
 * Why: a flat per-line cut treated a skill used every day the same as one
 * never used, and usually cut off the "use when…" part the model chooses by.
 * Claude Code and Codex both give the list a share of the context window,
 * keep every name, and shorten descriptions of the least-used skills first.
 */

export type CatalogSkill = { name: string; description?: string };

/** Share of the context window the skill list may take. */
const CATALOG_WINDOW_SHARE = 0.01;
const CATALOG_MIN_TOKENS = 1_000;
/** A huge window still pays for every token on every step, so the list stays small. */
const CATALOG_MAX_TOKENS = 2_500;
const CATALOG_DEFAULT_TOKENS = 1_800;
/** Longest description shown for a skill when there is room. */
export const FULL_DESCRIPTION_CHARS = 360;
/** What is left of a description once the list has to shrink. */
export const SHORT_DESCRIPTION_CHARS = 130;

/**
 * Rough token count for text in any script.
 * Why: limits counted in characters cost two to three times more in Persian
 * or Arabic than in English; tokenizers spend about one token per four
 * Latin characters and per two to three others.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 2.5);
}

/** The list's budget in tokens for a model with this context window (null when unknown). */
export function catalogBudgetTokens(contextWindow: number | null | undefined): number {
  if (!contextWindow || contextWindow <= 0) return CATALOG_DEFAULT_TOKENS;
  return Math.min(CATALOG_MAX_TOKENS, Math.max(CATALOG_MIN_TOKENS, Math.round(contextWindow * CATALOG_WINDOW_SHARE)));
}

/**
 * Shortens a description to a limit, ending on a sentence when one ends late enough, else on a word.
 */
export function clipDescription(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (sentence > limit * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(—-]+$/, "")}…`;
}

type Level = "full" | "short" | "name";

/**
 * Renders the skill list within a token budget.
 * Every skill starts with its description up to FULL_DESCRIPTION_CHARS. While
 * over budget it shrinks in this order: other skills to a short line, other
 * skills to a name, then the favored ones (those this agent has used) the
 * same way. Names that lost their description share one closing line, so
 * every installed skill is still listed.
 * Lines keep alphabetical order, so the text only changes when a skill is
 * installed or this agent's set of used skills changes; the cached prompt holds.
 */
export function budgetedCatalog(
  skills: CatalogSkill[],
  options: { budgetTokens: number; favored?: ReadonlySet<string> },
): string {
  const sorted = [...skills].sort((left, right) => left.name.localeCompare(right.name));
  if (sorted.length === 0) return "";
  const favored = options.favored ?? new Set<string>();
  const levels = new Map<string, Level>(sorted.map((skill) => [skill.name, "full"]));
  const render = (): string => {
    const lines: string[] = [];
    const bare: string[] = [];
    for (const skill of sorted) {
      const level = levels.get(skill.name);
      const description = (skill.description ?? "").trim();
      if (level === "name" || !description) {
        bare.push(skill.name);
        continue;
      }
      const limit = level === "full" ? FULL_DESCRIPTION_CHARS : SHORT_DESCRIPTION_CHARS;
      lines.push(`- ${skill.name}: ${clipDescription(description, limit)}`);
    }
    if (bare.length > 0) lines.push(`- Also installed (see one with \`read_skill\`): ${bare.join(", ")}`);
    return lines.join("\n");
  };
  let text = render();
  const others = sorted.filter((skill) => !favored.has(skill.name));
  const preferred = sorted.filter((skill) => favored.has(skill.name));
  // Longest descriptions shrink first: they free the most room per skill.
  const byLength = (group: CatalogSkill[]) =>
    [...group].sort((left, right) => (right.description?.length ?? 0) - (left.description?.length ?? 0));
  const passes: Array<[CatalogSkill[], Level]> = [
    [byLength(others), "short"],
    [byLength(others), "name"],
    [byLength(preferred), "short"],
    [byLength(preferred), "name"],
  ];
  for (const [group, level] of passes) {
    for (const skill of group) {
      if (estimateTextTokens(text) <= options.budgetTokens) return text;
      levels.set(skill.name, level);
      text = render();
    }
  }
  return text;
}

/**
 * Skills ranked by how many of the query's words appear in their name and description.
 * A word in the name counts double. Skills that match no word are left out.
 */
export function searchSkills<T extends CatalogSkill>(skills: T[], query: string): T[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1))];
  if (words.length === 0) return [];
  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const description = (skill.description ?? "").toLowerCase();
      const score = words.reduce((total, word) => total + (name.includes(word) ? 2 : 0) + (description.includes(word) ? 1 : 0), 0);
      return { skill, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .map((entry) => entry.skill);
}

/**
 * The skills one agent is shown by name: the product's own, the ones it
 * installed, and the ones its work used lately. The rest are counted.
 * Why: every agent was shown every skill on the account, so a marketplace
 * agent read fifteen LinkedIn skills and ten video variants on every step.
 * The others stay one `list_skills` search away.
 * Output: the skills to list, and how many were left out.
 */
export function skillsForAgent<T extends CatalogSkill & { source?: string }>(skills: T[], used: ReadonlySet<string>): { shown: T[]; hidden: number } {
  const shown = skills.filter((skill) => skill.source === "core" || skill.source === "own" || used.has(skill.name) || skill.source === undefined);
  return { shown, hidden: skills.length - shown.length };
}

/** The closing line for skills not listed, or "" when none were left out. */
export function hiddenSkillsLine(hidden: number): string {
  return hidden > 0
    ? `\n- ${hidden} more skills are installed on this account for other work; find one with \`list_skills\` and a \`query\` when a job needs it.`
    : "";
}
