import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "../computer/computer.js";
import { accountHome, accountShared, exec, execStdin } from "../linux/linux.js";
import { accountSkillRoot, parseSkillFrontmatter, type SkillSummary } from "./skills.js";

/** Canonical path used by `npx skills add -g` for universal agents. */
const LOCAL_SKILLS_SEGMENT = ".agents/skills";
const MAX_LOCAL_SKILLS = 100;
/** How often installs in agents' homes are copied to the shared folder. */
const PUBLISH_EVERY_MS = 2 * 60 * 1000;
const lastPublished = new Map<string, number>();

/**
 * The account-wide skills folder inside the account computer.
 * Input: account id. Output: `/shared/skills`.
 */
export function sharedSkillsRoot(accountId: string): string {
  return `${accountShared(accountId)}/skills`;
}

/**
 * Saves one skill into the account computer's shared skills folder.
 * Why: the server's skills directory holds only the skills every account
 * starts with. A skill that belongs to one account (one that came with a
 * plugin, one the person approved) lives on that account's computer, beside
 * the skills its agents install, so the account's skills are all in one place.
 * Input: account id and the full SKILL.md text; `keep` leaves a skill of the
 * same name as it is. Output: the skill's name. Runs as root; agents can read it.
 */
export async function writeSharedSkill(accountId: string, markdown: string, keep = false): Promise<{ name: string }> {
  const { name } = parseSkillFrontmatter(markdown);
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    throw new Error("A skill name may only use letters, digits and dashes.");
  }
  const directory = `${sharedSkillsRoot(accountId)}/${name}`;
  const body = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  const script = `${keep ? '[ -f "$1/SKILL.md" ] && exit 0; ' : ""}mkdir -p "$1" && cat > "$1/SKILL.md" && chmod -R a+rX "$1/.."`;
  const result = await execStdin(accountId, ["sh", "-c", script, "sh", directory], Buffer.from(body));
  if (result.code !== 0) {
    throw new Error(result.stdout.toString("utf8") || `The skill ${name} could not be saved.`);
  }
  return { name };
}

/**
 * Moves skills an older version kept on the server onto the account computer.
 * Why: account skills used to be written under `accounts/<account id>` in the
 * server's skills directory. They are moved once, the first time the account's
 * skills are read, and the server folder is removed. A computer that cannot be
 * reached leaves the folder alone, where it is still read, for the next try.
 * Input: the server's skills directory and the account id. Output: nothing.
 */
export async function adoptHostSkills(skillsRoot: string, accountId: string): Promise<void> {
  const old = accountSkillRoot(skillsRoot, accountId);
  if (!existsSync(old)) return;
  try {
    for (const entry of readdirSync(old, { withFileTypes: true })) {
      const file = join(old, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      // A skill of the same name already on the computer is the newer one.
      await writeSharedSkill(accountId, readFileSync(file, "utf8"), true);
    }
    rmSync(old, { recursive: true, force: true });
  } catch {
    // Not moved this time. The folder stays and is read from the server as before.
  }
}

/** Marks a folder in `/shared/skills` as a copy of a server skill; it holds the copy's signature. */
const SERVER_SKILL_MARK = ".server-skill";
/** How long a reading of the server's skill folders is trusted before the files are looked at again. */
const SIGNATURES_FOR_MS = 60 * 1000;
let signatures: { root: string; at: number; folders: { folder: string; signature: string }[] } | null = null;
const serverSkillsOn = new Map<string, string>();

/**
 * Copies the server's skills, with all their files, onto the account computer.
 * Why: a worker was given only the text of SKILL.md. That text tells it to run
 * the skill's scripts, copy its template and read its style guide, and none of
 * those files were on the computer the worker runs on. It then built from
 * nothing and the result was poor. Each skill is copied to `/shared/skills`
 * once and again when its files change on the server. A skill of the same name
 * the account installed for itself is left alone.
 * Input: the server's skills directory and the account id. Output: nothing.
 */
export async function publishHostSkills(skillsRoot: string, accountId: string): Promise<void> {
  const folders = serverSkillFolders(skillsRoot);
  const state = folders.map((entry) => `${entry.folder}:${entry.signature}`).join("|");
  if (serverSkillsOn.get(accountId) === state) return;
  const shared = sharedSkillsRoot(accountId);
  try {
    // One look at the computer: which copies are current, and which names the account owns.
    const seen = await exec(accountId, [
      "sh",
      "-c",
      `for name in "$@"; do d=${shellQuote(shared)}/"$name"; if [ -f "$d/${SERVER_SKILL_MARK}" ]; then echo "$name $(cat "$d/${SERVER_SKILL_MARK}")"; elif [ -e "$d" ]; then echo "$name own"; fi; done`,
      "sh",
      ...folders.map((entry) => entry.folder),
    ]);
    const onComputer = new Map(seen.stdout.split("\n").map((line) => line.trim().split(" ") as [string, string]));
    for (const { folder, signature } of folders) {
      const found = onComputer.get(folder);
      if (found === signature || found === "own") continue;
      const archive = await tarFolder(skillsRoot, folder);
      const unpack = `rm -rf "$1.new" && mkdir -p "$1.new" && tar -xf - -C "$1.new" --strip-components=1 --no-same-owner && printf %s "$2" > "$1.new/${SERVER_SKILL_MARK}" && rm -rf "$1" && mv "$1.new" "$1" && chmod -R a+rX "$1/.."`;
      const result = await execStdin(accountId, ["sh", "-c", unpack, "sh", `${shared}/${folder}`, signature], archive);
      if (result.code !== 0) throw new Error(result.stdout.toString("utf8") || `The skill ${folder} could not be copied.`);
    }
    serverSkillsOn.set(accountId, state);
  } catch {
    // Not copied this time. The skill's text is still read from the server, and the next read tries again.
  }
}

/** The server's skill folders, each with a signature that changes when any of its files does. */
function serverSkillFolders(root: string): { folder: string; signature: string }[] {
  if (signatures && signatures.root === root && Date.now() - signatures.at < SIGNATURES_FOR_MS) return signatures.folders;
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name) && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => {
      const hash = createHash("sha1");
      const walk = (directory: string, prefix: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
          if (item.name === "node_modules" || item.name === ".DS_Store") continue;
          const path = join(directory, item.name);
          if (item.isDirectory()) walk(path, `${prefix}${item.name}/`);
          else if (item.isFile()) {
            const stat = statSync(path);
            hash.update(`${prefix}${item.name}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
          }
        }
      };
      walk(join(root, entry.name), "");
      return { folder: entry.name, signature: hash.digest("hex") };
    });
  signatures = { root, at: Date.now(), folders };
  return folders;
}

/** One skill folder as a tar archive, without installed packages. */
function tarFolder(root: string, folder: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "tar",
      ["-cf", "-", "--exclude", "node_modules", "--exclude", ".DS_Store", "-C", root, folder],
      // COPYFILE_DISABLE keeps a Mac's tar from adding "._" files beside each real one.
      { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Copies skills installed in any agent's home into the shared skills folder.
 * Why: `npx skills add -g` installs into one agent's private home, which no
 * other agent can read. A skill the person had installed through one agent
 * was "not found" for the next, which then worked without it. One computer
 * per account means one set of skills: every agent sees what any agent installed.
 * Runs as root (homes are private), at most every two minutes per account.
 * Input: account id; `force` skips the wait after an install. Output: nothing.
 */
export async function publishLocalSkills(accountId: string, force = false): Promise<void> {
  const last = lastPublished.get(accountId) ?? 0;
  if (!force && Date.now() - last < PUBLISH_EVERY_MS) return;
  lastPublished.set(accountId, Date.now());
  const shared = shellQuote(sharedSkillsRoot(accountId));
  const script = [
    `mkdir -p ${shared}`,
    `for dir in /home/*/${LOCAL_SKILLS_SEGMENT}/*/; do`,
    `  [ -f "$dir/SKILL.md" ] || continue`,
    `  name="$(basename "$dir")"`,
    `  dest=${shared}/"$name"`,
    // Copy when it is new, or when the installed copy was updated since.
    `  if [ ! -f "$dest/SKILL.md" ] || [ "$dir/SKILL.md" -nt "$dest/SKILL.md" ]; then`,
    `    rm -rf "$dest.new" && cp -rL "$dir" "$dest.new" 2>/dev/null && rm -rf "$dest" && mv "$dest.new" "$dest"`,
    `  fi`,
    `done`,
    `chmod -R a+rX ${shared} 2>/dev/null`,
    `exit 0`,
  ].join("\n");
  try {
    await exec(accountId, ["bash", "-c", script]);
  } catch {
    // The account computer is not reachable: the agent still has host skills.
    lastPublished.delete(accountId);
  }
}

/**
 * Absolute skills directory inside one agent's Linux home.
 * Input: account id and Linux username. Output: `/home/<profile>/.agents/skills`.
 */
export function agentLocalSkillsRoot(accountId: string, profile: string): string {
  assertSafeProfile(profile);
  return `${accountHome(accountId, profile)}/${LOCAL_SKILLS_SEGMENT}`;
}

/**
 * Lists skills installed in this agent's container home.
 * Why: installs stay on the box (`npx skills add -g`); core never writes them
 * onto the host skills tree. A missing container or empty folder is an empty list.
 */
export async function localSkillCatalog(accountId: string, profile: string): Promise<SkillSummary[]> {
  await publishLocalSkills(accountId);
  // Shared first, so the agent's own install of the same skill wins.
  const paths = [...(await listSkillPaths(accountId, profile, sharedSkillsRoot(accountId))), ...(await listLocalSkillPaths(accountId, profile))];
  const byName = new Map<string, SkillSummary>();
  for (const path of paths) {
    try {
      const parsed = parseSkillFrontmatter(await readFile(accountId, profile, path));
      byName.set(parsed.name, { name: parsed.name, description: parsed.description });
    } catch {
      // Skip broken SKILL.md files so one bad install cannot hide the rest.
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads one container-local skill body by frontmatter name.
 * Output: markdown body, or null when this profile has no matching skill.
 */
export async function readLocalSkill(accountId: string, profile: string, name: string): Promise<string | null> {
  assertSafeProfile(profile);
  await publishLocalSkills(accountId);
  const roots = [agentLocalSkillsRoot(accountId, profile), sharedSkillsRoot(accountId)];
  if (/^[A-Za-z0-9._-]+$/.test(name)) {
    for (const root of roots) {
      const direct = `${root}/${name}/SKILL.md`;
      try {
        const parsed = parseSkillFrontmatter(await readFile(accountId, profile, direct));
        if (parsed.name === name) return withSkillDirectory(direct, parsed.body);
      } catch {
        // Not here, or the folder name differs from the skill's name: scan below.
      }
    }
  }
  for (const root of roots) {
    for (const path of await listSkillPaths(accountId, profile, root)) {
      try {
        const parsed = parseSkillFrontmatter(await readFile(accountId, profile, path));
        if (parsed.name === name) return withSkillDirectory(path, parsed.body);
      } catch {
        // Skip unreadable entries.
      }
    }
  }
  return null;
}

/**
 * Tells the reader where an installed skill lives on the computer.
 * Why: skill bodies link to sibling files with relative paths; without the
 * directory the model guesses an absolute path and the read fails.
 */
function withSkillDirectory(skillFile: string, body: string): string {
  const directory = skillFile.replace(/\/[^/]+$/, "");
  return `Skill directory: ${directory} (relative links in this skill resolve from here; sibling skills sit next to it)\n\n${body}`;
}

async function listLocalSkillPaths(accountId: string, profile: string): Promise<string[]> {
  return listSkillPaths(accountId, profile, agentLocalSkillsRoot(accountId, profile));
}

/** SKILL.md files one level under a skills folder, read as the agent. */
async function listSkillPaths(accountId: string, profile: string, root: string): Promise<string[]> {
  assertSafeProfile(profile);
  const quoted = shellQuote(root);
  try {
    const result = await exec(
      accountId,
      [
        "bash",
        "-lc",
        `if [ -d ${quoted} ]; then find ${quoted} -mindepth 2 -maxdepth 2 -type f -name SKILL.md 2>/dev/null | head -n ${MAX_LOCAL_SKILLS}; fi`,
      ],
      profile,
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function assertSafeProfile(profile: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new Error("Linux profile is invalid.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
