import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./local.js", () => ({
  adoptHostSkills: vi.fn(),
  localSkillCatalog: vi.fn(),
  readLocalSkill: vi.fn(),
}));

import { catalogTextForAgent, readSkillForAgent, skillCatalogForAgent } from "./agent-skills.js";
import { localSkillCatalog, readLocalSkill } from "./local.js";

const accountId = "11111111-1111-4111-8111-111111111111";
let root = "";

describe("agent-skills", () => {
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("merges host skills with container-local overrides", async () => {
    root = await mkdtemp(join(tmpdir(), "kuru-agent-skills-"));
    await writeSkill(root, "shared", "shared", "Shared skill.", "Shared body.");
    vi.mocked(localSkillCatalog).mockResolvedValue([{ name: "local", description: "Local skill." }]);
    vi.mocked(readLocalSkill).mockImplementation(async (_account, _profile, name) =>
      name === "local" ? "Local body." : null,
    );

    const catalog = await skillCatalogForAgent({
      skillsRoot: root,
      accountId,
      linuxProfile: "ada",
    });
    expect(catalog).toEqual([
      { name: "local", description: "Local skill." },
      { name: "shared", description: "Shared skill." },
    ]);
    expect(await catalogTextForAgent({ skillsRoot: root, accountId, linuxProfile: "ada" })).toContain(
      "local: Local skill.",
    );
    expect(await readSkillForAgent({ skillsRoot: root, accountId, linuxProfile: "ada" }, "local")).toBe("Local body.");
    expect(await readSkillForAgent({ skillsRoot: root, accountId, linuxProfile: "ada" }, "shared")).toBe("Shared body.");
  });
});

async function writeSkill(directory: string, folder: string, name: string, description: string, body: string) {
  const skillDirectory = join(directory, folder);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}
