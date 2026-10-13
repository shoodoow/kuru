/**
 * Hidden cue turns that rewake the dispatcher after worker failure.
 * DB: messages are NOT inserted for cues; run claims runs table.
 */
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { takeOver } from "../desktop/desktop.js";
import { publish, type StreamEvent } from "../rooms/stream.js";
import { claimDelivery, failuresSinceLastUser, MAX_STARTS_PER_ASK, startsSinceLastAsk, workerFollowupCue } from "../rooms/subagents.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { and, eq } from "drizzle-orm";
import { prompt } from "../prompt/prompts.js";

type Db = ReturnType<typeof getDb>;

export async function resumeParentAfterWorker(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    skillsRoot?: string;
    settled:
      | { workerId: string; task: string; result: string; delegationId: string; status: "done" | "failed" }
      | Array<{ workerId: string; task: string; result: string; delegationId: string; status: "done" | "failed" }>;
  },
  runTurn: (
    db: Db,
    accountId: string,
    conversationId: string,
    body: string,
    generate?: (input: TurnInput) => Promise<GenerateResult>,
    skillsRoot?: string,
    options?: { cue?: string; speakerId?: string; acquireTimeoutMs?: number; onEvent?: (event: StreamEvent) => void },
  ) => Promise<unknown>,
): Promise<void> {
  const settledList = Array.isArray(input.settled) ? input.settled : [input.settled];
  if (settledList.some((item) => /NEEDS_PERSON:/i.test(item.result))) {
    const [parent] = await db
      .select({ linuxProfile: agents.linuxProfile })
      .from(agents)
      .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
    if (parent?.linuxProfile) takeOver(input.accountId, parent.linuxProfile);
  }
  const allFailed = settledList.every((item) => item.status === "failed");
  const failures = allFailed
    ? await failuresSinceLastUser(db, input.accountId, input.conversationId, input.parentAgentId)
    : 0;
  // After this many starts for one request, the agent reports where things stand instead of starting again.
  const spent =
    (await startsSinceLastAsk(db, input.accountId, input.conversationId, input.parentAgentId).catch(() => 0)) >= MAX_STARTS_PER_ASK;
  const cue = spent
    ? `${allFailed ? workerFailedList(settledList) : workerCompletionCue(settledList)}\n\n${prompt("cues", "worker-rounds-spent", { starts: MAX_STARTS_PER_ASK })}`
    : allFailed
      ? workerFollowupCue({
          workerId: settledList[0]?.workerId ?? "",
          task: settledList[0]?.task ?? "",
          result: settledList[0]?.result ?? "",
          settled: settledList,
          retry: failures <= 1,
        })
      : workerCompletionCue(settledList);
  await runTurn(db, input.accountId, input.conversationId, cue, undefined, input.skillsRoot, {
    cue,
    speakerId: input.parentAgentId,
    acquireTimeoutMs: 120_000,
    onEvent: (event) => publish(input.accountId, input.conversationId, event),
  });
  await Promise.all(settledList.map((item) => claimDelivery(db, item.delegationId).catch(() => false)));
}

/** The failed results alone, without the "continue that worker" instruction that normally follows them. */
function workerFailedList(settled: Array<{ workerId: string; task: string; result: string }>): string {
  return settled
    .map((item) => prompt("cues", "worker-failed-item", { workerId: item.workerId, task: item.task.slice(0, 200), result: cleanReport(item.result).slice(0, 1_500) }))
    .join("\n\n");
}

/** Hidden completion cue: evidence goes to the parent, never straight to chat. */
function cleanReport(result: string): string {
  const text = result.replace(/\s+/g, " ").trim();
  if (/^(bash:|<!DOCTYPE|<html|[{"\[])/i.test(text)) return text.slice(0, 200);
  return text;
}

function workerCompletionCue(
  settled: Array<{ workerId: string; task: string; result: string; status: "done" | "failed" }>,
): string {
  const reports = settled
    .map((item, index) =>
      prompt("cues", "worker-result-item", {
        index: index + 1,
        status: item.status,
        workerId: item.workerId,
        task: item.task.slice(0, 200),
        report: cleanReport(item.result).slice(0, 3_500),
      }),
    )
    .join("\n\n");
  return prompt("cues", "worker-results", { reports });
}
