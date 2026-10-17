/**
 * Repairs tool inputs that are wrong in shape but clear in meaning.
 * Why: a rejected call costs a whole model step (the full prompt is resent)
 * and smaller models repeat the same slip: the brief under the wrong key, a
 * list sent as a JSON string, a number sent as text. Fixing those here is
 * cheaper than teaching every model the schema. DB: none.
 */

/** Moves a worker brief written under `instructions` into `task`. */
export function mergeWorkerBrief(input: Record<string, unknown>): Record<string, unknown> {
  if (input.kind === "custom") return input;
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const extra = typeof input.instructions === "string" ? input.instructions.trim() : "";
  if (!extra) return input;
  const { instructions: _dropped, ...rest } = input;
  // A short title plus the real brief is the common shape; keep both.
  return { ...rest, task: task && !extra.includes(task) ? `${task}\n\n${extra}` : extra };
}

/** Turns "a, b" or '["a","b"]' into a list. Anything else is returned as is. */
function asList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON after all; fall through to the comma split.
    }
  }
  return text
    .split(",")
    .map((item) => item.trim().replace(/^["'[]+|["'\]]+$/g, ""))
    .filter((item) => item.length > 0);
}

/**
 * Returns a repaired copy of one tool call's input, or null when nothing changed.
 * Input: tool name and the raw JSON text the model produced.
 * Output: JSON text to validate again, or null.
 */
export function repairToolInput(toolName: string, raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let fixed: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const [key, value] of Object.entries(fixed)) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    // Lists and objects sent as JSON text.
    if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
      try {
        fixed[key] = JSON.parse(text);
      } catch {
        // Leave the string; validation will report it.
      }
    }
  }
  if (toolName === "spawn_worker") {
    fixed = mergeWorkerBrief(fixed);
    if (fixed.skills !== undefined) fixed.skills = asList(fixed.skills);
    if (typeof fixed.maxSteps === "string" && /^\d+$/.test(fixed.maxSteps.trim())) {
      fixed.maxSteps = Number(fixed.maxSteps);
    }
    if (typeof fixed.maxSteps === "number") fixed.maxSteps = Math.min(Math.max(Math.round(fixed.maxSteps), 3), 40);
  }
  if (toolName === "write") {
    if (fixed.content !== undefined && fixed.body === undefined) {
      fixed.body = fixed.content;
      delete fixed.content;
    }
    if (fixed.file !== undefined && fixed.path === undefined) {
      fixed.path = fixed.file;
      delete fixed.file;
    }
  }
  if (toolName === "read") {
    if (fixed.file !== undefined && fixed.path === undefined) {
      fixed.path = fixed.file;
      delete fixed.file;
    }
  }
  const next = JSON.stringify(fixed);
  return next === JSON.stringify(parsed) ? null : next;
}
