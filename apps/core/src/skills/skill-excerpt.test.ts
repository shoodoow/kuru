import { describe, expect, it } from "vitest";
import { skillDirectoryOf, skillExcerpt } from "./skill-excerpt.js";

const section = (title: string, size: number) => `## ${title}\n${"word ".repeat(size / 5)}\n`;

describe("skillExcerpt", () => {
  it("returns a short skill whole", () => {
    expect(skillExcerpt("## A\nshort", 100)).toEqual({ text: "## A\nshort", omitted: [] });
  });

  it("cuts where a section starts and names the sections left out", () => {
    const body = [section("Setup", 400), section("Creating", 400), section("Editing", 400), section("Pitfalls", 400)].join("\n");
    const excerpt = skillExcerpt(body, 1_000);
    expect(excerpt.text.endsWith("word")).toBe(true);
    expect(excerpt.text).toContain("## Creating");
    expect(excerpt.text).not.toContain("## Editing");
    expect(excerpt.omitted).toEqual(["Editing", "Pitfalls"]);
  });

  it("does not take a comment inside a code block for a heading", () => {
    const body = `${section("Setup", 300)}\n\`\`\`python\n# Read Excel\n${"x = 1\n".repeat(40)}\`\`\`\n${section("Writing", 400)}`;
    const excerpt = skillExcerpt(body, 500);
    expect(excerpt.omitted).toEqual(["Writing"]);
    expect(excerpt.omitted).not.toContain("Read Excel");
  });

  it("reads the skill folder from the line put before a local skill", () => {
    expect(skillDirectoryOf("Skill directory: /shared/skills/docx (relative links…)\n\n# Docx")).toBe("/shared/skills/docx");
    expect(skillDirectoryOf("# Docx")).toBeNull();
  });
});
