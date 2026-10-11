/**
 * Pure loop-control rules for the dispatcher.
 * Why: every extra model step resends the whole prompt and tool schemas, so
 * the loop must end the moment the turn's job is done, and it must never end
 * with the person hearing nothing. DB: none.
 */
import { prompt } from "../prompt/prompts.js";

/** Tools that talk or take notes. Everything else is work the model must read back. */
const VOICE_TOOLS = new Set([
  "send_message",
  "react_to_message",
  "notify_user",
  "todo_write",
  "todo_list",
  "remember_fact",
  "correct_memory",
]);

export function isWorkTool(name: string): boolean {
  return !VOICE_TOOLS.has(name);
}

/**
 * Decides whether the dispatcher loop ends after the step that just finished.
 * Input: tool names per finished step, plus what the turn has done so far.
 * Output: true when another model call could only produce throwaway text.
 */
export function shouldEndTurn(input: {
  stepToolNames: string[][];
  /** A worker or teammate was started this turn. */
  handedOff: boolean;
  /** At least one bubble landed this turn. */
  sentMessage: boolean;
  /** Hidden wake: silence is allowed. */
  hiddenTurn: boolean;
}): boolean {
  const last = input.stepToolNames.at(-1) ?? [];
  if (last.length === 0) return false;
  // Work is running in the background and the person knows (or need not know).
  if (input.handedOff && (input.sentMessage || input.hiddenTurn)) return true;
  // A bubble sent after earlier work was read back is the answer, not an ack.
  const earlierWork = input.stepToolNames.slice(0, -1).some((names) => names.some(isWorkTool));
  const lastIsVoiceOnly = last.includes("send_message") && !last.some(isWorkTool);
  return earlierWork && lastIsVoiceOnly;
}


/**
 * Narrows the next step to replying when the turn is about to end silent.
 * Input: finished step count, the step cap, and what the turn has done.
 * Output: the reply-only restriction, or null to leave the step open.
 */
export function replyOnlyRestriction(input: {
  finishedSteps: number;
  maxSteps: number;
  handedOff: boolean;
  sentMessage: boolean;
  hiddenTurn: boolean;
  /** Tool names per finished step; setup-only steps extend the budget. */
  stepToolNames?: string[][];
}): { activeTools: string[]; note: string } | null {
  if (input.handedOff && !input.hiddenTurn && !input.sentMessage) {
    return { activeTools: ["send_message"], note: prompt("dispatcher", "ack-handoff") };
  }
  // Setting up a team is bookkeeping (open the group, hire each teammate,
  // write the brief), not research. Those steps do not eat the budget, or the
  // turn closed right before the request that starts the work.
  const setupSteps = (input.stepToolNames ?? []).filter(
    (names) => names.length > 0 && names.every((name) => SETUP_TOOLS.has(name)),
  ).length;
  const closeAt = input.maxSteps + Math.min(setupSteps, MAX_SETUP_STEPS);
  if (input.maxSteps > 1 && input.finishedSteps >= closeAt - 1) {
    // Handing the job to a worker is a valid way to finish: it ends the turn
    // at once, and it is what the model usually wants after reading around.
    // Locking it out left the turn with a promise and nothing running.
    return { activeTools: [...CLOSING_TOOLS], note: prompt("dispatcher", "reply-now") };
  }
  return null;
}

/** What the model may still call when a turn has to close. */
export const CLOSING_TOOLS = ["send_message", "spawn_worker", "delegate"] as const;

/** Team bookkeeping calls that do not count against the step budget. */
const SETUP_TOOLS = new Set(["enable_tools", "create_group", "hire_subagent", "set_team_brief", "add_to_group", "update_teammate"]);
const MAX_SETUP_STEPS = 6;

/** What the model may call when asked to act on a promise it just made. */
export const FOLLOW_THROUGH_TOOLS = ["spawn_worker", "stop_worker", "redirect_worker", "delegate"] as const;

const IN_PROGRESS =
  /\b(still (going|running|working|rendering|building|processing|in progress|at it)|in progress|(is|are|it['’]?s) (now )?(running|rendering|re-?rendering|building|processing|underway|being \w+)|running (now|right now)|render(ing)? (is |now|right now)|underway|chugging|working on (it|that|this)|i['’]?m (now |still |currently )?(building|rendering|re-?rendering|fixing|installing|running|working on|applying|checking|verifying|finishing|generating|creating|making)|(have|['’]ve) (re)?started|kicked (it |that )?off|should (land|be ready|be done) (soon|shortly)|(is|are) on it\b)/i;

/**
 * Spots a reply that tells the person work is going on.
 * Why: after a worker stopped, agents kept answering "still rendering" for
 * forty minutes with nothing running. The claim is cheap to check against
 * what is actually running, so the loop checks it.
 * Input: the reply text. Output: true when it says something is in progress.
 */
export function claimsWorkInProgress(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 1500) return false;
  return IN_PROGRESS.test(trimmed);
}

const PROMISE =
  /\b(let me|i['’]?ll|i will|i['’]?m going to|i am going to|i['’]?m about to|give me a (moment|sec|second|minute)|one moment|hang on|hold on|on it|right away|kicking off|getting (it|that|this) (going|started))\b/i;

/**
 * Spots a reply that promises work the turn never started.
 * Why: "Let me get the render going" with no tool call leaves the person
 * waiting on nothing until they ask again. The text is still a fine reply,
 * so it is kept; the loop just gets one step to do what was promised.
 * Input: the reply text and whether a worker was started this turn.
 * Output: true when one follow-through step should run.
 */
export function promisesUnstartedWork(input: { text: string; handedOff: boolean; hiddenTurn: boolean }): boolean {
  if (input.handedOff || input.hiddenTurn) return false;
  const text = input.text.trim();
  if (!text || text.length > 700) return false;
  // A question hands the turn to the person; nothing is owed yet.
  if (/[?؟]\s*$/.test(text)) return false;
  return PROMISE.test(text);
}

/**
 * Whether final plain text still needs posting after bubbles were sent.
 * Why: "ack, then look things up, then answer in plain text" is the normal
 * shape of a turn; the answer must not be dropped just because an ack went
 * out earlier. Text that follows a bubble with no work in between is only a
 * sign-off and stays unposted.
 * Input: tool names per step. Output: true when work ran after the last bubble.
 */
export function finalTextIsReply(stepToolNames: string[][]): boolean {
  let lastBubble = -1;
  stepToolNames.forEach((names, index) => {
    if (names.includes("send_message")) lastBubble = index;
  });
  if (lastBubble < 0) return true;
  return stepToolNames.slice(lastBubble).some((names) => names.some(isWorkTool));
}

/**
 * True when a plain reply writes a card as text instead of sending one.
 * Why: a card reaches the person only through send_message. A reply holding
 * "[widget:question]", or a copy of how history describes an earlier card,
 * left them with a promise of a question and nothing to tap.
 */
export function announcesUnsentCard(text: string): boolean {
  return /\[widget:[a-z]/i.test(text) || text.includes("(Shown to the person as a");
}

/**
 * True when a plain reply ends by asking the person something.
 * Why: the default agent must ask with a tappable card. Small models say "pick
 * what sounds closest:" and then send no card, which leaves the person
 * answering "What?". The loop uses this to make the card get sent.
 * Input: the reply text. Output: true when its last lines hold a question or lead into a list of choices.
 */
export function asksInPlainText(text: string): boolean {
  const tail = text.trim().slice(-400);
  return tail.includes("?") || /[:：]\s*$/.test(tail);
}

/**
 * Removes reasoning a model wrote into its reply by mistake.
 * Why: small models sometimes open the reply with a long bracketed note to
 * themselves ("(Let me think about what just happened...)"), which the person
 * then reads as the message.
 * Input: the reply text. Output: the text without that opening note.
 */
export function stripLeakedThinking(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("(")) return text;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        const note = trimmed.slice(0, index + 1);
        const toSelf = /\b(let me|i need to|i should|i'll need|the person (wants|is|said)|the user (wants|is|said))\b/i.test(note);
        return note.length > 200 && toSelf ? trimmed.slice(index + 1).trimStart() : text;
      }
    }
  }
  return text;
}
