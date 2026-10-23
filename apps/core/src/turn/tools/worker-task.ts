/**
 * Soft cleanup before spawn_worker.
 * Why: every rejection costs the dispatcher a full model step (the whole
 * prompt is resent) just to retype the brief, and a keyword check on the
 * wording rejected briefs that were perfectly runnable. Only two things are
 * refused: a brief too short to act on and one too long for a single worker.
 * Chromium-kill lines are stripped rather than rejected. Returns the task to run.
 */
// The goal alone; the rest of the brief has its own fields.
const MIN_TASK_CHARS = 20;
// Generous on purpose: the brief is the worker's whole world, and a rejected
// brief left the person with a promise and nothing running.
const MAX_TASK_CHARS = 16_000;

export function validateWorkerTask(task: string): { ok: true; task: string } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < MIN_TASK_CHARS) {
    return {
      ok: false,
      hint: "The goal is too short for a worker that starts blank. Say what to produce, for whom, and how good it must be.",
    };
  }
  if (trimmed.length > MAX_TASK_CHARS) {
    return {
      ok: false,
      hint: `Task is too long (${trimmed.length} chars). Keep task to the goal and put the rest in context, rules, method, checks and deliver; name files instead of pasting their contents.`,
    };
  }

  const cleaned = trimmed
    .replace(/\bpkill\b[^\n.]*chrom[^\n.]*/gi, "")
    .replace(/\bkillall\s+chromium\b/gi, "")
    .replace(/\bclose all chrome\b/gi, "")
    .replace(/\bclose every chrome\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ok: true, task: cleaned.length >= MIN_TASK_CHARS ? cleaned : trimmed };
}

const BRIEF_PARTS = ["context", "rules", "method", "checks", "deliver"] as const;

/**
 * Joins the goal and the labeled parts of a spawn_worker call into the one brief the worker reads.
 * The goal stays first and untagged, because job titles and the duplicate check read the first line.
 */
export function assembleBrief(parts: { task: string } & Partial<Record<(typeof BRIEF_PARTS)[number], string>>): string {
  const sections = BRIEF_PARTS.filter((name) => parts[name]?.trim()).map(
    (name) => `<${name}>\n${parts[name]?.trim()}\n</${name}>`,
  );
  return [parts.task.trim(), ...sections].join("\n\n");
}

/** Joins the parts of a redirect_worker call into the one note the worker reads: what is done, then the next action, then anything else. */
export function redirectNote(parts: { next: string; done?: string; instruction?: string }): string {
  return [parts.done?.trim() && `Already done: ${parts.done.trim()}`, `Next: ${parts.next.trim()}`, parts.instruction?.trim()]
    .filter(Boolean)
    .join("\n\n");
}
