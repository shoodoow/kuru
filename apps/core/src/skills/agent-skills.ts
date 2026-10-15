import { adoptHostSkills, localSkillCatalog, publishHostSkills, readLocalSkill, readProductSkill } from "./local.js";
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
  // The product's own skills win over an agent's install of the same name, description and all.
  const core = new Map(host.map((skill) => [skill.name, skill]));
  return mergeSkillCatalogs(host, local).map((skill) => {
    const product = core.get(skill.name);
    return product ? { ...product, source: "core" as const } : skill;
  });
}

/**
 * Loads one skill body. The account computer's copy wins over a default skill of the same name.
 */
export async function readSkillForAgent(ctx: AgentSkillContext, name: string): Promise<string> {
  if (ctx.skillsRoot) await adoptHostSkills(ctx.skillsRoot, ctx.accountId);
  // The copy on the computer is read first: it comes with the folder its scripts and templates are in.
  if (ctx.skillsRoot && ctx.linuxProfile) await publishHostSkills(ctx.skillsRoot, ctx.accountId);
  // The product's skill wins over an agent's install of the same name.
  const isProduct = Boolean(ctx.skillsRoot) && skillCatalogForAccount(ctx.skillsRoot!, ctx.accountId).some((skill) => skill.name === name);
  if (ctx.linuxProfile && isProduct) {
    const product = await readProductSkill(ctx.accountId, ctx.linuxProfile, name);
    if (product) return product;
    return readSkillForAccount(ctx.skillsRoot!, ctx.accountId, name);
  }
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
