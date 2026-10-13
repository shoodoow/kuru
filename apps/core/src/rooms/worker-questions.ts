/**
 * A worker's questions to the agent it works for.
 * Why: a worker that lacked something only the agent or the person knows (a
 * preference, which of two options, a missing input) either guessed or
 * stopped with a blocker, and the job started over. It can now ask once and
 * wait. The agent has the whole chat and its memory, so it usually answers at
 * once; the answer comes back through the note it already sends to a running
 * worker. The limits keep a weak model from turning this into a conversation.
 * DB: none; a question lives only while its worker is running in this process.
 */

/** Questions one job may ask. */
export const MAX_QUESTIONS_PER_JOB = 2;
/** How long a worker waits for the answer before carrying on with its own choice. */
export const QUESTION_WAIT_MS = 3 * 60 * 1000;

type Pending = { answer: (text: string) => void };

const pending = new Map<string, Pending>();
const asked = new Map<string, number>();

/** Things a worker is expected to work out itself. */
const OWN_JOB = /^\s*(how (do|can|should|would) (i|we|you)\b|how to\b|what (command|tool|library|package|flag)\b|which (command|tool|library|package)\b|can you (help|tell me how))/i;

export type WorkerQuestion = { question: string; options?: string[]; pick?: string };

/**
 * Asks the agent one question and waits for the answer.
 * Input: the delegation id, the question, and `wake`, which starts the agent's turn.
 * Output: the text the worker reads: the answer, or why there is none and what to do.
 */
export async function askAgent(
  delegationId: string,
  input: WorkerQuestion,
  wake: (cue: WorkerQuestion) => Promise<void> | void,
  waitMs = QUESTION_WAIT_MS,
): Promise<string> {
  const question = input.question.trim();
  const fallback = input.pick?.trim()
    ? `Carry on with your own choice ("${input.pick.trim()}") and say in your report that you chose it.`
    : "Carry on with the most sensible choice and say in your report what you chose.";
  if (OWN_JOB.test(question)) {
    return "That is yours to work out: look it up, read the tool's help, or try it. Ask only for what the agent or the person alone can know (a preference, a choice between options, a missing input).";
  }
  if (pending.has(delegationId)) return "You already have a question waiting. Wait for that answer.";
  const count = asked.get(delegationId) ?? 0;
  if (count >= MAX_QUESTIONS_PER_JOB) {
    return `You have asked ${MAX_QUESTIONS_PER_JOB} questions on this job, which is the limit. ${fallback}`;
  }
  asked.set(delegationId, count + 1);
  let timer: NodeJS.Timeout | undefined;
  const answered = new Promise<string | null>((resolve) => {
    pending.set(delegationId, { answer: (text) => resolve(text) });
    timer = setTimeout(() => resolve(null), waitMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    // The wake is not awaited: the agent's turn may take longer than the answer needs.
    void Promise.resolve(wake({ ...input, question })).catch(() => undefined);
    const answer = await answered;
    if (answer === null) {
      return `No answer came in time. ${fallback} If an answer arrives later as a note, follow it from where you are.`;
    }
    return `The agent you work for answers: ${answer}`;
  } finally {
    clearTimeout(timer);
    pending.delete(delegationId);
  }
}

/**
 * Hands a waiting worker its answer.
 * Input: the delegation id and the answer. Output: false when that worker has no question waiting.
 */
export function answerWorkerQuestion(delegationId: string, answer: string): boolean {
  const waiting = pending.get(delegationId);
  if (!waiting) return false;
  waiting.answer(answer);
  return true;
}

/** Forgets a finished job's count. */
export function forgetWorkerQuestions(delegationId: string): void {
  asked.delete(delegationId);
  pending.delete(delegationId);
}
