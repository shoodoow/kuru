/**
 * Auto-review: block risky tool calls until a person approves them.
 * Why: destructive shell and irreversible room/schedule
 * deletes wait on a card instead of running on the model's first try.
 */
import { prompt } from "../prompt/prompts.js";
import { accountHome } from "../linux/linux.js";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, agents, messages, toolAllowances, toolApprovals } from "../db/schema.js";
import { saveNotification } from "../notify/notify.js";
import { saveSendMessage, withWidgetProps } from "../rooms/send-message.js";
import type { ToolContext } from "./tools/context.js";

type Db = ReturnType<typeof getDb>;

export type AutoReviewDecision =
  | { allow: true }
  | { allow: false; blocked: true; approvalId: string; reason: string };

const DESTRUCTIVE_BASH = [
  /\brm\s+-[^\n]*rf\b/i,
  /\brm\s+-[^\n]*fr\b/i,
  /\brm\s+-[^\n]*\br\b[^\n]*\bf\b/i,
  /\brm\s+-[^\n]*\bf\b[^\n]*\br\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(\.|$|\s)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\./i,
];

/**
 * Hashes a tool call without retry flags so approve-and-retry matches.
 * Input: tool name + raw input. Output: hex sha256.
 */
export function hashToolInput(name: string, input: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "requestApproval" || key === "approvalId") continue;
    // Stable order so the same batch delete retries match after approval.
    if (key === "routineIds" && Array.isArray(value)) {
      copy[key] = [...value].map(String).sort();
      continue;
    }
    copy[key] = value;
  }
  return createHash("sha256").update(`${name}:${JSON.stringify(copy)}`).digest("hex");
}

const RM_PATTERNS = DESTRUCTIVE_BASH.slice(0, 4);

/** A folder the agent may clear without asking: inside /tmp or inside its own home. */
function isOwnPath(target: string, home: string): boolean {
  const path = target.replace(/^(['"])(.*)\1$/, "$2");
  if (!path || /[$`\\]/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) return false;
  const inside = (root: string): boolean => path.startsWith(`${root}/`) && path.length > root.length + 1 && !/^[/*.]+$/.test(path.slice(root.length + 1));
  if (path.startsWith("~/")) return path.length > 2 && !/^[/*.]+$/.test(path.slice(2));
  if (path.startsWith("/")) return inside("/tmp") || (home.length > 1 && inside(home));
  return false;
}

/**
 * True when every recursive delete in a command stays inside the agent's own space.
 * Why: clearing its own build folder or a scratch folder in /tmp is routine
 * work. Asking the person each time stalled jobs for many minutes and taught
 * them to approve without reading. Anything it cannot fully read stays risky.
 * Input: the command and the agent's home folder. Output: whether no approval is needed.
 */
export function deletesOnlyOwnFiles(command: string, home: string): boolean {
  if (!home || /\bsudo\b/.test(command)) return false;
  const mentions = command.match(/\brm\b/g)?.length ?? 0;
  let parsed = 0;
  // The shell starts in the agent's home, so relative paths are its own until it leaves.
  let cwdOwn = true;
  for (const raw of command.split(/&&|\|\||[;|\n]/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const head = words[0];
    if (!head) continue;
    if (head === "cd") {
      const to = words[1] ?? "~";
      cwdOwn = to === "~" || to === home || isOwnPath(to, home) || (cwdOwn && !to.startsWith("/") && !to.startsWith("~") && !/(^|\/)\.\.(\/|$)/.test(to) && !/[$`]/.test(to));
      continue;
    }
    if (head !== "rm") continue;
    parsed += 1;
    const targets = words.slice(1).filter((word) => !word.startsWith("-") && !/^\d?>/.test(word) && word !== "2>&1");
    if (targets.length === 0) return false;
    for (const target of targets) {
      const clean = target.replace(/^(['"])(.*)\1$/, "$2");
      const relativeOwn =
        cwdOwn && !clean.startsWith("/") && !clean.startsWith("~") && !/[$`\\]/.test(clean) && !/(^|\/)\.\.(\/|$)/.test(clean) && !/^[/*.]+$/.test(clean);
      if (!isOwnPath(clean, home) && !relativeOwn) return false;
    }
  }
  return parsed > 0 && parsed === mentions;
}

/** What each publishing or deleting tool of the YouTube, Instagram and TikTok plugins does, for the approval card. */
const SOCIAL_ACTIONS: Record<string, string> = {
  youtube_upload_video: "Upload to YouTube",
  youtube_delete_video: "Delete a YouTube video",
  youtube_delete_playlist: "Delete a YouTube playlist",
  youtube_post_comment: "Comment on YouTube",
  youtube_reply_to_comment: "Reply to a YouTube comment",
  instagram_publish_photo: "Publish a photo on Instagram",
  instagram_publish_reel: "Publish a reel on Instagram",
  instagram_publish_story: "Publish a story on Instagram",
  instagram_publish_carousel: "Publish a carousel on Instagram",
  instagram_post_comment: "Comment on Instagram",
  instagram_reply_to_comment: "Reply to an Instagram comment",
  instagram_delete_comment: "Delete an Instagram comment",
  tiktok_post_video: "Post a video on TikTok",
  tiktok_post_photos: "Post photos on TikTok",
  tiktok_upload_draft: "Send a draft to the TikTok inbox",
};

/**
 * The approval line for a social plugin call that publishes or deletes, or null for any other call.
 * Why in code and not only in the prompt: a post is public the moment it is
 * made. With Auto-review on, the person sees what is about to go out and where.
 */
function socialRisk(name: string, input: Record<string, unknown>): string | null {
  const action = SOCIAL_ACTIONS[name];
  if (!action) return null;
  const what = input.title ?? input.caption ?? input.text ?? input.path ?? (Array.isArray(input.paths) ? input.paths.join(", ") : undefined) ?? input.id ?? input.commentId ?? "";
  const where = [typeof input.account === "string" ? `as ${input.account}` : "", typeof input.privacy === "string" ? input.privacy : ""].filter(Boolean).join(", ");
  return `${action}${where ? ` (${where})` : ""}: ${String(what).replace(/\s+/g, " ")}`.slice(0, 180);
}

/**
 * Classifies whether this call is risky enough to wait on a person.
 * Input: tool name + args, and the agent's home folder when known.
 * Output: a one-line reason, or null when safe.
 */
export function classifyRisk(name: string, input: Record<string, unknown>, home?: string): string | null {
  if (name === "bash") {
    const command = String(input.command ?? "");
    const risky = DESTRUCTIVE_BASH.filter((pattern) => pattern.test(command));
    if (risky.length === 0) return null;
    // Only the delete rules matched, and every delete is inside the agent's own space.
    if (home && risky.every((pattern) => RM_PATTERNS.includes(pattern)) && deletesOnlyOwnFiles(command, home)) return null;
    return `Destructive shell: ${command.slice(0, 160)}`;
  }
  if (name === "delete_group" && input.confirmed === true) {
    return `Delete group ${String(input.conversationId ?? "")}`.trim();
  }
  if (name === "fire_agent") {
    const why = typeof input.reason === "string" && input.reason.trim() ? ` (${input.reason.trim()})` : "";
    return `Remove the agent ${String(input.agent ?? "")} for good, with its chat and what it kept for itself${why}`.slice(0, 180);
  }
  if (name === "delete_routine") {
    return `Delete routine ${String(input.routineId ?? "")}`.trim();
  }
  if (name === "gmail_send") {
    const to = String(input.to ?? input.draftId ?? "a recipient");
    return `Send email to ${to}`.slice(0, 180);
  }
  const social = socialRisk(name, input);
  if (social) return social;
  if (name === "delete_routines") {
    if (input.all === true) return "Delete all of your routines";
    const ids = Array.isArray(input.routineIds) ? input.routineIds.map(String) : [];
    const sorted = [...ids].sort();
    if (sorted.length === 0) return "Delete routines";
    if (sorted.length === 1) return `Delete routine ${sorted[0]}`;
    return `Delete ${sorted.length} routines`;
  }
  return null;
}

/** Calls that wait for the person whether or not Auto-review is on. */
const ALWAYS_ASK = new Set(["fire_agent"]);

/**
 * Tools that can never be allowed for good: a shell allowance would cover any
 * destructive command, and removing an agent cannot be undone.
 */
const NEVER_ALWAYS = new Set(["bash", ...ALWAYS_ASK]);

/** True when an approval for this tool may offer "Always allow". */
export function canAlwaysAllow(tool: string): boolean {
  return !NEVER_ALWAYS.has(tool);
}

/**
 * The agent an allowance belongs to: a worker acts for the agent that started it.
 * Input: db, account and agent ids. Output: the lasting agent's id.
 */
export async function allowanceOwner(db: Db, accountId: string, agentId: string): Promise<string> {
  const [row] = await db
    .select({ parentId: agents.parentId, hidden: agents.hidden })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  return row?.hidden && row.parentId ? row.parentId : agentId;
}

/** True when the person said "Always allow" for this agent and tool. */
async function alwaysAllowed(db: Db, accountId: string, agentId: string, tool: string): Promise<boolean> {
  if (!canAlwaysAllow(tool)) return false;
  const owner = await allowanceOwner(db, accountId, agentId);
  const [row] = await db
    .select({ id: toolAllowances.id })
    .from(toolAllowances)
    .where(and(eq(toolAllowances.accountId, accountId), eq(toolAllowances.agentId, owner), eq(toolAllowances.tool, tool)))
    .limit(1);
  return Boolean(row);
}

/** Saves "Always allow" for the agent behind an approval, for that approval's tool. */
export async function allowForGood(db: Db, accountId: string, approval: { agentId: string; tool: string }): Promise<void> {
  if (!canAlwaysAllow(approval.tool)) return;
  const owner = await allowanceOwner(db, accountId, approval.agentId);
  await db.insert(toolAllowances).values({ accountId, agentId: owner, tool: approval.tool }).onConflictDoNothing();
}

/** An action as the person reads it: "Publish a reel on Instagram" rather than the tool's name. */
export function actionLabel(tool: string): string {
  return SOCIAL_ACTIONS[tool] ?? (tool === "gmail_send" ? "Send email" : tool.replace(/_/g, " "));
}

/** The account's allowances, newest first, with the agent's name and the action in words. */
export async function listAllowances(db: Db, accountId: string) {
  const rows = await db
    .select({ id: toolAllowances.id, tool: toolAllowances.tool, agentId: toolAllowances.agentId, agentName: agents.name, createdAt: toolAllowances.createdAt })
    .from(toolAllowances)
    .innerJoin(agents, eq(agents.id, toolAllowances.agentId))
    .where(eq(toolAllowances.accountId, accountId))
    .orderBy(desc(toolAllowances.createdAt));
  return rows.map((row) => ({ ...row, label: actionLabel(row.tool) }));
}

/** Takes an allowance back, so that agent asks again. */
export async function removeAllowance(db: Db, accountId: string, id: string): Promise<boolean> {
  const removed = await db
    .delete(toolAllowances)
    .where(and(eq(toolAllowances.id, id), eq(toolAllowances.accountId, accountId)))
    .returning({ id: toolAllowances.id });
  return removed.length > 0;
}

/**
 * Runs Auto-review for one tool call.
 * Input: tool context, name, args. Output: allow, or a blocked payload for the model.
 */
export async function reviewToolCall(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<AutoReviewDecision> {
  const home = ctx.linuxProfile ? accountHome(ctx.accountId, ctx.linuxProfile) : undefined;
  const reason = classifyRisk(name, input, home);
  if (!reason) return { allow: true };

  const [account] = await ctx.db
    .select({ autoReview: accounts.autoReview })
    .from(accounts)
    .where(eq(accounts.id, ctx.accountId));
  // Removing an agent cannot be undone, so it is asked even with Auto-review off.
  if (!account?.autoReview && !ALWAYS_ASK.has(name)) return { allow: true };
  // The person said "Always allow" for this agent and this action.
  if (await alwaysAllowed(ctx.db, ctx.accountId, ctx.voiceAgentId ?? ctx.agentId, name)) return { allow: true };

  const hash = hashToolInput(name, input);
  const approvalId = typeof input.approvalId === "string" ? input.approvalId : "";
  const retry = input.requestApproval === true && approvalId.length > 0;

  if (retry) {
    const [row] = await ctx.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.accountId, ctx.accountId),
          eq(toolApprovals.tool, name),
          eq(toolApprovals.inputHash, hash),
        ),
      );
    if (!row) {
      return {
        allow: false,
        blocked: true,
        approvalId,
        reason: "That approval id does not match this tool call. Ask again or wait for the person.",
      };
    }
    if (row.status === "denied") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: "The person denied this action. Do not retry it. Take a safer path or ask what they want.",
      };
    }
    if (row.status === "approved" && !row.usedAt) {
      await ctx.db.update(toolApprovals).set({ usedAt: new Date() }).where(eq(toolApprovals.id, row.id));
      return { allow: true };
    }
    if (row.status === "approved") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: "That approval was already used. Ask the person again if you still need this.",
      };
    }
    if (row.status === "pending") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: `Auto-review is still waiting on the person (${row.id}). Do not reshape the command to slip past it.`,
      };
    }
  }

  const [existing] = await ctx.db
    .select()
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.accountId, ctx.accountId),
        eq(toolApprovals.conversationId, ctx.conversationId),
        eq(toolApprovals.tool, name),
        eq(toolApprovals.inputHash, hash),
        eq(toolApprovals.status, "approved"),
        isNull(toolApprovals.usedAt),
      ),
    )
    .limit(1);
  if (existing) {
    await ctx.db.update(toolApprovals).set({ usedAt: new Date() }).where(eq(toolApprovals.id, existing.id));
    return { allow: true };
  }

  const speakerId = ctx.voiceAgentId ?? ctx.agentId;
  const [created] = await ctx.db
    .insert(toolApprovals)
    .values({
      accountId: ctx.accountId,
      agentId: speakerId,
      conversationId: ctx.conversationId,
      tool: name,
      inputHash: hash,
      summary: reason.slice(0, 2000),
    })
    .returning();
  if (!created) throw new Error("Auto-review insert returned no row.");

  const saved = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: speakerId,
    runId: ctx.runId,
    blocks: [
      {
        kind: "widget",
        widget: "approval",
        props: {
          title: "Needs approval",
          detail: reason,
          approvalId: created.id,
          tool: name,
          // The card offers "Always allow" only where one yes may cover every later call.
          canAlwaysAllow: canAlwaysAllow(name),
        },
      },
    ],
    createdAt: ctx.nextTime(),
  });
  await ctx.db.update(toolApprovals).set({ messageId: saved.id }).where(eq(toolApprovals.id, created.id));
  ctx.emittedMessages.push(saved);
  await ctx.emit({ type: "message", message: saved });
  const ping = await saveNotification(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    agentId: speakerId,
    messageId: saved.id,
    title: "Needs your approval",
    body: reason.slice(0, 280),
    urgency: "action-needed",
  });
  await ctx.emit({ type: "notify", notification: ping });

  return {
    allow: false,
    blocked: true,
    approvalId: created.id,
    reason:
      `Auto-review blocked this ${name} call. Tell the person in one sentence and wait. ` +
      `After they approve, retry the SAME call with requestApproval:true and approvalId:"${created.id}". ` +
      `Do not rewrite, encode, or route around it. Reason: ${reason}`,
  };
}

/** Approval cards a worker is waiting on in place, so deciding one does not also wake the agent. */
const awaitedApprovals = new Set<string>();

/** True while a worker is paused on this approval and will carry on by itself. */
export function isApprovalAwaited(approvalId: string): boolean {
  return awaitedApprovals.has(approvalId);
}

/** How long a paused worker waits for the person before it moves on without the action. */
export const APPROVAL_WAIT_MS = 30 * 60 * 1000;

/**
 * Waits for the person to decide one approval card.
 * Why: a blocked worker used to be stopped and restarted blank once the
 * person tapped Approve, losing everything it had done. Now it simply pauses
 * on the card and carries on with the same action.
 * Input: db, account, approval id, and how long to wait.
 * Output: the decision, or "timeout" when nobody answered.
 */
export async function waitForApproval(
  db: Db,
  accountId: string,
  approvalId: string,
  options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onTick?: () => Promise<void> | void },
): Promise<"approved" | "denied" | "timeout"> {
  const deadline = Date.now() + (options?.timeoutMs ?? APPROVAL_WAIT_MS);
  const pollMs = options?.pollMs ?? 2_000;
  awaitedApprovals.add(approvalId);
  try {
    let ticks = 0;
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) return "timeout";
      const [row] = await db
        .select({ status: toolApprovals.status })
        .from(toolApprovals)
        .where(and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId)));
      if (!row) return "timeout";
      if (row.status === "approved") {
        await db.update(toolApprovals).set({ usedAt: new Date() }).where(eq(toolApprovals.id, approvalId));
        return "approved";
      }
      if (row.status === "denied") return "denied";
      ticks += 1;
      if (ticks % 10 === 0) await options?.onTick?.();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return "timeout";
  } finally {
    awaitedApprovals.delete(approvalId);
  }
}

export async function getAutoReview(db: Db, accountId: string): Promise<boolean> {
  const [row] = await db.select({ autoReview: accounts.autoReview }).from(accounts).where(eq(accounts.id, accountId));
  return row?.autoReview ?? true;
}

export async function getAccountSettings(db: Db, accountId: string) {
  const [row] = await db
    .select({ autoReview: accounts.autoReview, timezone: accounts.timezone })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row ?? null;
}

/**
 * Stores the phone's zone the first time it arrives.
 * Why: later opens must not overwrite a zone the person already set.
 * Input: account id and a zone name. Output: the saved settings, or null.
 */
export async function rememberTimezone(db: Db, accountId: string, timezone: string) {
  const current = await getAccountSettings(db, accountId);
  if (!current) return null;
  if (current.timezone.trim()) return current;
  const [row] = await db
    .update(accounts)
    .set({ timezone })
    .where(eq(accounts.id, accountId))
    .returning({ autoReview: accounts.autoReview, timezone: accounts.timezone });
  return row ?? null;
}

export function isTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function setAutoReview(db: Db, accountId: string, autoReview: boolean) {
  const [row] = await db
    .update(accounts)
    .set({ autoReview })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id, autoReview: accounts.autoReview });
  return row ?? null;
}

export async function listToolApprovals(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.accountId, accountId), eq(toolApprovals.status, "pending")));
  return rows.map((row) => ({ ...row, canAlwaysAllow: canAlwaysAllow(row.tool) }));
}

export async function decideToolApproval(
  db: Db,
  accountId: string,
  approvalId: string,
  decision: "approved" | "denied",
) {
  const [row] = await db
    .update(toolApprovals)
    .set({ status: decision })
    .where(
      and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId), eq(toolApprovals.status, "pending")),
    )
    .returning();
  if (row) return row;
  // Idempotent: a second tap after a successful approve must not 404.
  const [existing] = await db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId)));
  if (existing?.status === decision) return existing;
  return null;
}

/**
 * Writes approved/denied onto the chat approval card so the phone can hide the buttons.
 * Input: db + account/conversation + approval id + decision. Output: updated message or null.
 */
export async function markApprovalWidget(
  db: Db,
  accountId: string,
  conversationId: string,
  approvalId: string,
  decision: "approved" | "denied",
) {
  const [approval] = await db
    .select({ messageId: toolApprovals.messageId })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId)));
  const inRoom = and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId));
  // Cards saved before approvals recorded their message are found the old
  // way, by scanning the room for the approval id.
  const rows = approval?.messageId
    ? await db.select().from(messages).where(and(inRoom, eq(messages.id, approval.messageId)))
    : await db
        .select()
        .from(messages)
        .where(and(inRoom, sql`${messages.payload}::text like ${`%${approvalId}%`}`))
        .orderBy(desc(messages.createdAt))
        .limit(5);
  const match = rows.find((row) => {
    return (row.payload ?? []).some(
      (block) => block.kind === "widget" && block.widget === "approval" && block.props.approvalId === approvalId,
    );
  });
  if (!match?.payload) return null;
  const [updated] = await db
    .update(messages)
    .set({ payload: withWidgetProps(match.payload, "approval", { status: decision }) })
    .where(and(eq(messages.id, match.id), eq(messages.accountId, accountId)))
    .returning();
  return updated ?? null;
}

/** Cue that rewakes the room agent after a person decides an Auto-review card. */
export function approvalDecisionCue(
  row: { id: string; tool: string; summary: string },
  decision: "approved" | "denied",
): string {
  return prompt("cues", decision === "approved" ? "approval-approved" : "approval-denied", {
    summary: row.summary,
    tool: row.tool,
    approvalId: row.id,
  });
}
