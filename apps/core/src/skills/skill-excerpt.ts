/**
 * The opening of a skill that fits a limit, cut where a section starts.
 * Why: a cut at a fixed character count could end mid-rule or mid-code, and
 * the worker only learned "the rest is missing". Both Claude Code and Codex
 * load a skill's main file whole and keep the details in other files; when a
 * skill here is still too long, the worker gets whole sections plus the names
 * of the ones left out, so it reads just the one it needs.
 */

export type SkillExcerpt = {
  text: string;
  /** Headings of the sections that were left out, in order. Empty when nothing was cut. */
  omitted: string[];
};

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function skillExcerpt(body: string, limit: number): SkillExcerpt {
  if (body.length <= limit) return { text: body, omitted: [] };
  const lines = body.split("\n");
  let offset = 0;
  let inFence = false;
  let lastHeadingCut = -1;
  let lastBlankCut = -1;
  const headings: Array<{ at: number; title: string }> = [];
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const heading = HEADING.exec(line);
      if (heading) {
        headings.push({ at: offset, title: heading[2]! });
        if (offset <= limit) lastHeadingCut = offset;
      } else if (line.trim() === "" && offset <= limit) {
        lastBlankCut = offset;
      }
    }
    offset += line.length + 1;
  }
  // A section boundary late enough to keep most of the room; else a paragraph; else the limit.
  const cut = lastHeadingCut >= limit * 0.5 ? lastHeadingCut : lastBlankCut >= limit * 0.5 ? lastBlankCut : limit;
  return {
    text: body.slice(0, cut).trimEnd(),
    omitted: headings.filter((heading) => heading.at >= cut).map((heading) => heading.title),
  };
}

/** The skill's folder on the computer, from the line `readLocalSkill` puts first. */
export function skillDirectoryOf(body: string): string | null {
  return /^Skill directory: (\S+)/.exec(body)?.[1] ?? null;
}
