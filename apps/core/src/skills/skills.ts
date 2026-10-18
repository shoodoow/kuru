import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Where an older version kept one account's skills, one level down. They now
// live on the account's computer (see local.ts) and are moved there when
// read. The folder name is fixed and is never listed as a default skill.
const ACCOUNT_SKILLS = "accounts";

export type SkillSummary = {
  name: string;
  description: string;
  /** Where it comes from: shipped with the product, installed for the whole account, or installed by this agent. */
  source?: "core" | "shared" | "own";
  /** `checkpoint: true` in the frontmatter: a job on this skill stops once with a preview before its costly part. */
  checkpoint?: boolean;
};

export type ParsedSkill = { name: string; description: string; body: string; checkpoint?: boolean };

/**
 * Parses Agent Skills frontmatter from a SKILL.md body.
 * Input: full file text. Output: name, description, and markdown after the fence.
 * Supports plain, quoted, and YAML block scalars (`>` / `|`) for description.
 */
export function parseSkillFrontmatter(text: string): ParsedSkill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md is missing frontmatter.");
  }
  const fields = parseFrontmatterFields(match[1] ?? "");
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) {
    throw new Error("SKILL.md needs a name and a description.");
  }
  const checkpoint = fields.get("checkpoint")?.trim().toLowerCase() === "true";
  return { name, description, body: (match[2] ?? "").trim(), ...(checkpoint ? { checkpoint } : {}) };
}

/** YAML block indicators: folded `>`, literal `|`, with optional chomping (`-` / `+`). */
const BLOCK_SCALAR = /^(>|\|)([+-])?$/;

/**
 * Reads top-level frontmatter keys. Nested maps (e.g. `metadata:`) are skipped;
 * only scalar keys we care about (`name`, `description`) need to resolve.
 */
function parseFrontmatterFields(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    index += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // Nested / continuation lines without a top-level key.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    const block = BLOCK_SCALAR.exec(value);
    if (block) {
      const folded = block[1] === ">";
      const collected: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (next.trim() === "") {
          collected.push("");
          index += 1;
          continue;
        }
        if (!/^\s/.test(next)) break;
        collected.push(next.trim());
        index += 1;
      }
      value = folded
        ? collected.filter((part) => part.length > 0).join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) fields.set(key, value);
  }
  return fields;
}

/**
 * Merges skill layers left-to-right; later layers override the same name.
 * Why: shared host skills, legacy account folders, and container-local installs
 * stack cleanly without callers reimplementing Map logic.
 */
export function mergeSkillCatalogs(...layers: SkillSummary[][]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();
  for (const layer of layers) {
    for (const skill of layer) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Lists the skills in one directory.
 * Input: a directory whose children are Agent Skills folders.
 * Output: each skill's name and description, sorted by name. The body is not included.
 */
export function skillCatalog(directory: string): SkillSummary[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ACCOUNT_SKILLS)
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path));
  return names
    .map((path) => parseSkillFrontmatter(readFileSync(path, "utf8")))
    .map((skill) => ({ name: skill.name, description: skill.description, ...(skill.checkpoint ? { checkpoint: true } : {}) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads one skill body.
 * Input: the skills directory and the skill name from its frontmatter.
 * Output: the markdown after the frontmatter. A missing name throws.
 */
export function readSkill(directory: string, name: string): string {
  const match = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ACCOUNT_SKILLS)
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .map((path) => parseSkillFrontmatter(readFileSync(path, "utf8")))
    .find((skill) => skill.name === name);
  if (!match) {
    throw new Error(`Skill ${name} is missing.`);
  }
  return match.body;
}

/**
 * Directory where an older version wrote one account's skills on the server.
 * Still read until its skills have been moved to the account's computer.
 * The id is a uuid from our database, so the path cannot escape.
 * Input: skills root and account id. Output: absolute directory path.
 */
export function accountSkillRoot(root: string, accountId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error("Account id is not a uuid.");
  }
  return join(root, ACCOUNT_SKILLS, accountId);
}

/**
 * Lists host skills visible to one account (shared + optional account folder).
 * Container-local skills are merged separately via skillCatalogForAgent.
 */
export function skillCatalogForAccount(root: string, accountId: string): SkillSummary[] {
  const ownRoot = accountSkillRoot(root, accountId);
  const own = existsSync(ownRoot) ? skillCatalog(ownRoot) : [];
  return mergeSkillCatalogs(skillCatalog(root), own);
}

/**
 * Loads one skill body for one account from the host skills tree.
 * A missing account copy falls through to the shared skill.
 */
export function readSkillForAccount(root: string, accountId: string, name: string): string {
  const ownRoot = accountSkillRoot(root, accountId);
  if (existsSync(ownRoot)) {
    try {
      return readSkill(ownRoot, name);
    } catch (error) {
      if (!(error instanceof Error) || !/missing/.test(error.message)) throw error;
    }
  }
  return readSkill(root, name);
}
