import { describe, expect, it } from "vitest";
import { budgetedCatalog, catalogBudgetTokens, estimateTextTokens, hiddenSkillsLine, searchSkills, skillsForAgent } from "./catalog-budget.js";

const skill = (name: string) => ({
  name,
  description: `Builds ${name} files with templates and scripts. Use when the person asks for a ${name} or edits one they sent. ${"Detail ".repeat(40)}`,
});

describe("budgetedCatalog", () => {
  it("keeps every name and the used skills' descriptions when the list must shrink", () => {
    const skills = Array.from({ length: 60 }, (_, index) => skill(`skill-${String(index).padStart(2, "0")}`));
    const text = budgetedCatalog(skills, { budgetTokens: 1_000, favored: new Set(["skill-42"]) });
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(1_000);
    for (const { name } of skills) expect(text).toContain(name);
    expect(text).toContain("- skill-42: Builds skill-42 files");
  });

  it("shows full descriptions when there is room, in name order", () => {
    const text = budgetedCatalog([skill("pptx"), skill("docx")], { budgetTokens: 2_000 });
    expect(text.indexOf("docx")).toBeLessThan(text.indexOf("pptx"));
    expect(text).toContain("Use when the person asks for a docx");
  });

  it("finds skills by words in their name first, then their description", () => {
    const skills = [
      { name: "kinetic-reel", description: "Short vertical videos with captions." },
      { name: "docx", description: "Word documents, reports and letters." },
      { name: "captions", description: "Burns subtitles into a clip." },
    ];
    expect(searchSkills(skills, "video captions").map((found) => found.name)).toEqual(["captions", "kinetic-reel"]);
    expect(searchSkills(skills, "spreadsheet")).toEqual([]);
  });

  it("shows an agent the product's skills, its own and the ones its work used, and counts the rest", () => {
    const skills = [
      { name: "docx", description: "Word files.", source: "core" },
      { name: "fiverr-research", description: "Fiverr niches.", source: "own" },
      { name: "linkedin-post-writer", description: "LinkedIn posts.", source: "shared" },
      { name: "hyperframes-audio", description: "Video audio.", source: "shared" },
    ];
    const { shown, hidden } = skillsForAgent(skills, new Set(["hyperframes-audio"]));
    expect(shown.map((skill) => skill.name)).toEqual(["docx", "fiverr-research", "hyperframes-audio"]);
    expect(hidden).toBe(1);
    expect(hiddenSkillsLine(1)).toMatch(/1 more skills .*list_skills/);
    expect(hiddenSkillsLine(0)).toBe("");
  });

  it("scales the budget with the context window, within bounds", () => {
    expect(catalogBudgetTokens(null)).toBe(1_800);
    expect(catalogBudgetTokens(32_000)).toBe(1_000);
    expect(catalogBudgetTokens(200_000)).toBe(2_000);
    expect(catalogBudgetTokens(1_000_000)).toBe(2_500);
  });
});
