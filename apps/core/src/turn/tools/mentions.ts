/** Words just before a name that mean "do not use it". */
const NOT_THIS = /\b(no|not|never|without|avoid|instead of|rather than|retired|don'?t use|do not use|stop using|drop)\b[^.\n]{0,25}$/i;

/**
 * Whether a brief mentions a name as something to use, not something to leave out.
 * Why: "no HyperFrames" in a brief had loaded the HyperFrames skill into the job.
 * Input: the brief and a name. Output: true when at least one mention is not negated.
 */
export function mentionedToUse(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (!NOT_THIS.test(lower.slice(Math.max(0, at - 40), at))) return true;
  }
  return false;
}
