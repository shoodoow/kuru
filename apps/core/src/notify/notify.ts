import { notifyInputSchema } from "@kuru/agent-tools";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { notifications } from "../db/schema.js";

/**
 * Saves one user ping to the notify outbox.
 * Why: outbox, not direct send — the row commits in the same short tx as its
 * trigger (a tool call mid-turn), so a crash redelivers instead of losing the
 * ping. Collapses to one active row per run: the agent updating "still
 * working" refreshes the pending ping instead of stacking twenty pushes.
 * Input: store, account/conversation/run ids, optional message id, title/body/urgency.
 * Output: the saved (or collapsed) notification row.
 */
export async function saveNotification(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    runId?: string | null;
    agentId?: string | null;
    messageId?: string | null;
    title: string;
    body: string;
    urgency?: "info" | "action-needed";
  },
) {
  const parsed = notifyInputSchema.parse({
    title: input.title,
    body: input.body,
    urgency: input.urgency ?? "info",
    messageId: input.messageId ?? null,
  });
  if (input.runId) {
    const [existing] = await store
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.runId, input.runId),
          eq(notifications.status, "pending"),
          eq(notifications.accountId, input.accountId),
        ),
      );
    if (existing) {
      const [updated] = await store
        .update(notifications)
        .set({
          title: parsed.title,
          body: parsed.body,
          urgency: parsed.urgency,
          messageId: parsed.messageId,
          conversationId: input.conversationId,
        })
        .where(eq(notifications.id, existing.id))
        .returning();
      if (!updated) throw new Error("Notification update returned no row.");
      return updated;
    }
  }
  const [row] = await store
    .insert(notifications)
    .values({
      accountId: input.accountId,
      runId: input.runId ?? null,
      conversationId: input.conversationId,
      messageId: parsed.messageId,
      agentId: input.agentId ?? null,
      title: parsed.title,
      body: parsed.body,
      urgency: parsed.urgency,
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("Notification insert returned no row.");
  return row;
}

/**
 * Lists pending outbox rows for the relay tick.
 * Why: the scheduler claims these oldest-first and applies delivery policy.
 * An account filter scopes relay (and tests) to one tenant at a time.
 * Input: store, batch limit, optional account id. Output: pending rows.
 */
export async function listPendingNotifications(store: Store, limit = 50, accountId?: string) {
  const base = store
    .select()
    .from(notifications)
    .where(
      accountId
        ? and(eq(notifications.status, "pending"), eq(notifications.accountId, accountId))
        : eq(notifications.status, "pending"),
    )
    .orderBy(notifications.createdAt)
    .limit(limit);
  return base;
}

/**
 * Marks a notification delivered.
 * Why: terminal state stops redelivery; the row stays as an audit trail of
 * what the user was told and when.
 * Input: store, notification id. Output: nothing.
 */
export async function markNotificationSent(store: Store, id: string): Promise<void> {
  await store.update(notifications).set({ status: "sent" }).where(eq(notifications.id, id));
}

/**
 * Marks a notification failed with the reason.
 * Why: push failures (bad token, Expo error) must be visible, never silent —
 * the pending list stays queryable and the error names the cause.
 * Input: store, id, error text. Output: nothing.
 */
export async function markNotificationFailed(store: Store, id: string, error: string): Promise<void> {
  await store
    .update(notifications)
    .set({ status: "failed", error: error.slice(0, 2000) })
    .where(eq(notifications.id, id));
}

/**
 * Decides whether a notification becomes a push or stays in-app.
 * Why: pure policy, unit-tested without devices: an open room (live SSE
 * watchers) never pushes — the banner suffices. Closed app pushes only when
 * the user asked (agent notify flag) unless the agent flagged action-needed
 * (approvals, human-gate steps), which always pushes because the run blocks.
 * Input: watchers present, agent notify flag, urgency. Output: true = push.
 */
export function shouldPush(input: { hasWatchers: boolean; agentNotify: boolean; urgency: "info" | "action-needed" }): boolean {
  if (input.hasWatchers) return false;
  if (input.urgency === "action-needed") return true;
  return input.agentNotify;
}
