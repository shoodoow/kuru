import { adoptHostSkills, localSkillCatalog, readLocalSkill } from "./local.js";
import {
  mergeSkillCatalogs,
  readSkillForAccount,
  skillCatalogForAccount,
  type SkillSummary,
} from "./skills.js";

export type AgentSkillContext = {
  skillsRoot?: string;
  accountId: string;
  /** Linux username; when set, `~/.agents/skills` in that home is merged in. */
  linuxProfile?: string | null;
};

/**
 * Skills this agent can load: the server's default skills, then the account's own.
 * Why: the skills every account starts with ship with the product; everything
 * that belongs to one account lives on that account's computer, in
 * `/shared/skills` (all its agents) and `~/.agents/skills` (one agent).
 */
export async function skillCatalogForAgent(ctx: AgentSkillContext): Promise<SkillSummary[]> {
  if (ctx.skillsRoot) await adoptHostSkills(ctx.skillsRoot, ctx.accountId);
  const host = ctx.skillsRoot ? skillCatalogForAccount(ctx.skillsRoot, ctx.accountId) : [];
  const local = ctx.linuxProfile ? await localSkillCatalog(ctx.accountId, ctx.linuxProfile) : [];
  return mergeSkillCatalogs(host, local);
}

/**
 * Loads one skill body. The account computer's copy wins over a default skill of the same name.
 */
export async function readSkillForAgent(ctx: AgentSkillContext, name: string): Promise<string> {
  if (ctx.skillsRoot) await adoptHostSkills(ctx.skillsRoot, ctx.accountId);
  if (ctx.linuxProfile) {
    const local = await readLocalSkill(ctx.accountId, ctx.linuxProfile, name);
    if (local !== null) return local;
  }
  if (!ctx.skillsRoot) {
    throw new Error(`Skill ${name} is missing.`);
  }
  return readSkillForAccount(ctx.skillsRoot, ctx.accountId, name);
}

/** Catalog lines for tool responses (`name: description` per skill). */
export async function catalogTextForAgent(ctx: AgentSkillContext): Promise<string> {
  return (await skillCatalogForAgent(ctx))
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join("\n");
}
