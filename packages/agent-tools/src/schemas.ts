import {
  allowedEmojis,
  providerNames,
  sendMessageInputSchema,
  urgencySchema,
} from "@kuru/shared";
import { z } from "zod";

export { sendMessageInputSchema };

/**
 * What the model fills in for send_message.
 * Why: the stored block schema also carries server-side fields (saved paths,
 * previews, blob references) and large size limits. None of that is the
 * model's business, and every extra schema line is resent on each step. The
 * executor still validates against the full `sendMessageInputSchema`.
 */
export const sendMessageToolInputSchema = z.object({
  blocks: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("text"), markdown: z.string().min(1) }),
        z.object({ kind: z.literal("image"), url: z.string().min(1), alt: z.string().optional() }),
        z.object({ kind: z.literal("code"), code: z.string().min(1), language: z.string().optional() }),
        z.object({ kind: z.literal("file"), url: z.string().min(1), name: z.string().min(1) }),
        z.object({
          kind: z.literal("widget"),
          widget: z.enum([
            "question",
            "poll",
            "checklist",
            "table",
            "chart",
            "approval",
            "agent-card",
            "secret",
            "desktop-handover",
          ]),
          props: z.object({}).catchall(z.unknown()),
        }),
      ]),
    )
    .min(1)
    .max(10),
  replyTo: z.string().uuid().nullable().optional(),
});

export const emptyToolInputSchema = z.object({});

export const memberAddInputSchema = z.object({
  agentId: z.string().uuid().describe("Existing teammate UUID from list_team. Not someone you just hired — hire_subagent already adds them."),
  /** Required from a private 1:1. Group id from create_group. */
  conversationId: z
    .string()
    .uuid()
    .optional()
    .describe("Group to add them to. Required when you are in a private 1:1. Omit when you are already in that group."),
});

/** @deprecated import name — same as memberAddInputSchema */
export const memberAddSchema = memberAddInputSchema;

export const workerRefInputSchema = z.object({
  workerId: z.string().uuid(),
});

export const workerRedirectInputSchema = z.object({
  workerId: z.string().uuid(),
  /** What the worker should do now. It keeps its context, so say only what is new. */
  instruction: z.string().trim().min(8).max(8000),
});

/** check_worker: one worker by id, or every worker of this chat when omitted. */
export const workerCheckInputSchema = z.object({
  workerId: z.string().uuid().optional(),
});

export const groupCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  memberIds: z.array(z.string().uuid()).max(19).optional().default([]),
  /** The team's shared brief: goal, who does what, how work is handed on, where files live. */
  brief: z.string().trim().max(6_000).optional(),
});

export const messageAgentInputSchema = z.object({
  /** The other agent's name as listed under "Other agents" (or its id). */
  agent: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(6_000),
  /** False when you are only passing information on and need nothing back. */
  wantsReply: z.boolean().optional().default(true),
});

export const teamBriefInputSchema = z.object({
  brief: z.string().trim().min(10).max(6_000),
  /** The group to brief. Optional when you own one group or are speaking in it. */
  conversationId: z.string().uuid().optional(),
});

export const accountBriefInputSchema = z.object({
  brief: z.string().trim().min(10).max(4_000),
});

export const hireAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  /** "work" does jobs on its own computer. "companion" is for conversation only. */
  kind: z.enum(["work", "companion"]),
  /** The agent's voice: a sentence or two on how it talks. */
  personality: z.string().trim().min(10).max(500),
  jobDescription: z.string().trim().min(20).max(10_000),
});

/** What a newly created agent writes about itself once it knows what the person wants. */
export const ownProfileInputSchema = z.object({
  role: z.string().trim().min(1).max(100),
  /** The agent's voice: a sentence or two on how it talks. */
  personality: z.string().trim().min(10).max(500),
  jobDescription: z.string().trim().min(20).max(10_000),
  /** "work" does jobs on its own computer. "companion" is for conversation only. */
  kind: z.enum(["work", "companion"]).optional().default("work"),
});

/** Another agent on this account, by the name listed under "Other agents" (or its id). */
const otherAgentField = z.string().trim().min(1).max(120);

export const agentMemoryReadInputSchema = z.object({
  agent: otherAgentField,
});

export const agentMemoryAddInputSchema = z.object({
  agent: otherAgentField,
  body: z.string().trim().min(3).max(1000),
  kind: z.enum(["fact", "person", "org", "project", "preference", "decision", "commitment"]).optional(),
  /** The person, company or project the fact is about. Leave out for facts about the person themself. */
  subject: z.string().trim().max(120).optional(),
});

export const agentMemoryCorrectInputSchema = z.object({
  agent: otherAgentField,
  oldBody: z.string().trim().min(3).max(1000),
  body: z.string().trim().min(3).max(1000),
});

export type GroupCreateInput = z.infer<typeof groupCreateInputSchema>;

/** Retry fields after Auto-review. Stripped from the input hash so approve-and-retry matches. */
const autoReviewRetryFields = {
  requestApproval: z.boolean().optional(),
  approvalId: z.string().uuid().optional(),
};

export const groupConversationInputSchema = z.object({
  conversationId: z.string().uuid(),
  /** Approval gate: destructive and irreversible — model must ask the person first, then re-call with confirmed:true. */
  confirmed: z.boolean().optional(),
  ...autoReviewRetryFields,
});

export type GroupConversationInput = z.infer<typeof groupConversationInputSchema>;

export const subagentCreateSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("A human first name you choose, such as Maya or Jordan. Never the job title."),
  role: z.string().trim().min(1).max(100).describe("The job title, such as SEO analyst. This is not their name."),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  /** Required when hiring from a private 1:1 — use conversationId from create_group. */
  conversationId: z.string().uuid().optional(),
});

export type SubagentCreate = z.infer<typeof subagentCreateSchema>;

export const teammateUpdateSchema = z.object({
  agentId: z.string().uuid().describe("Teammate UUID from list_team."),
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("New human first name, one word, such as Maya. Replaces their name. Never a job title."),
  role: z.string().trim().min(1).max(100).optional().describe("New job title. Not their name."),
  personality: z.string().trim().max(500).optional(),
  jobDescription: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .optional()
    .describe("New standing instructions: what they own and how they should work."),
});

export type TeammateUpdate = z.infer<typeof teammateUpdateSchema>;

export const delegateSchema = z.object({
  agentId: z.string().uuid().describe("Teammate UUID from hire_subagent or list_team."),
  task: z.string().trim().min(1).max(20_000),
  /** Required when delegating from a private 1:1 — same id passed to hire_subagent. */
  conversationId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Group the teammate should speak in. Required from a private 1:1 — use the conversationId from create_group / hire_subagent. Omit when you are already in that group.",
    ),
});

export type DelegateInput = z.infer<typeof delegateSchema>;

export const notifyInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  urgency: urgencySchema.optional().default("info"),
  messageId: z.string().uuid().nullable().optional(),
});

export type NotifyInput = z.infer<typeof notifyInputSchema>;

export const reactionSchema = z.object({
  messageId: z.string().uuid(),
  emoji: z.enum(allowedEmojis),
});

export type ReactionInput = z.infer<typeof reactionSchema>;

export const readHistoryToolInputSchema = z.object({
  messageId: z.string().uuid().optional(),
  search: z.string().optional(),
});

const memoryScopeSchema = z
  .enum(["agent", "user"])
  .describe('"agent" is kept by this agent only. "user" is shared with every agent on the account. Do not send an agent id.');

export const rememberFactToolInputSchema = z.object({
  scope: memoryScopeSchema,
  body: z.string().trim().min(3).max(1000),
  /** Source message. Optional: defaults to the message that opened this turn. */
  messageId: z.string().uuid().optional(),
});

export const correctMemoryToolInputSchema = z.object({
  scope: memoryScopeSchema,
  oldBody: z.string().trim().min(3).max(1000),
  body: z.string().trim().min(3).max(1000),
  messageId: z.string().uuid().optional(),
});

export const searchMemoryInputSchema = z.object({
  query: z.string().trim().min(2).max(300),
  /** Optional date range, as YYYY-MM-DD. */
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
});

export const enableToolsInputSchema = z.object({
  set: z.enum(["team", "routines", "admin"]),
});

export const readSkillToolInputSchema = z.object({
  name: z.string().min(1),
});

export const workerKindNames = [
  "executor",
  "computer",
  "browser",
  "explore",
  "shell",
  "debug",
  "watch_video",
  "video_review",
  "vm_setup",
  "docs",
  "custom",
] as const;

export type WorkerKindName = (typeof workerKindNames)[number];

const spawnWorkerFields = {
  label: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
  task: z.string().trim().min(1).max(20_000),
  /** Specialist standing method. Default computer (desktop-capable). Use custom + instructions when none fit. */
  kind: z.enum(workerKindNames).optional().default("computer"),
  /** Required when kind is custom: the standing method the worker follows. */
  instructions: z.string().trim().min(1).max(20_000).optional(),
  /** Accepted for older callers and ignored: a worker runs until the job is done. */
  maxSteps: z.number().int().min(1).max(500).optional(),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
};

function refineCustomWorkerKind(
  value: { kind?: string; instructions?: string },
  ctx: z.RefinementCtx,
) {
  if (value.kind === "custom" && !(value.instructions && value.instructions.trim())) {
    ctx.addIssue({
      code: "custom",
      message: "kind custom requires instructions (the standing method for this new worker type).",
      path: ["instructions"],
    });
  }
}

export const spawnWorkerInputSchema = z.object(spawnWorkerFields).superRefine(refineCustomWorkerKind);

/**
 * Tool surface for spawn_worker. The model writes only the brief and the kind;
 * the worker's label and role are derived, and it always inherits the
 * chatting agent's provider/model.
 */
export const spawnWorkerToolInputSchema = z
  .object({
    task: spawnWorkerFields.task,
    kind: z.enum(workerKindNames).optional().default("executor"),
    /** Skill names loaded into the worker's prompt so it does not spend a step reading them. */
    skills: z.array(z.string().trim().min(1).max(100)).max(4).optional(),
    instructions: spawnWorkerFields.instructions,
    maxSteps: spawnWorkerFields.maxSteps,
  })
  .superRefine(refineCustomWorkerKind);

export type SpawnWorkerInput = z.infer<typeof spawnWorkerInputSchema>;
export type SpawnWorkerToolInput = z.infer<typeof spawnWorkerToolInputSchema>;

export const routineCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).optional().default("UTC"),
  paused: z.boolean().optional().default(false),
});

export type RoutineCreateInput = z.infer<typeof routineCreateInputSchema>;

export const routineUpdateInputSchema = z.object({
  routineId: z.string().uuid(),
  title: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  paused: z.boolean().optional(),
});

export type RoutineUpdateInput = z.infer<typeof routineUpdateInputSchema>;

export const routineIdSchema = z.object({
  routineId: z.string().uuid(),
  ...autoReviewRetryFields,
});

export type RoutineId = z.infer<typeof routineIdSchema>;

/**
 * Batch delete: either all of the caller's routines, or an explicit id list.
 * Why: one Auto-review card for "clear my schedules", not N single deletes.
 */
export const deleteRoutinesInputSchema = z
  .object({
    all: z.boolean().optional(),
    routineIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    ...autoReviewRetryFields,
  })
  .superRefine((value, context) => {
    if (value.all === true) return;
    if (value.routineIds && value.routineIds.length > 0) return;
    context.addIssue({
      code: "custom",
      message: 'Pass all:true to clear every routine, or routineIds:[...] for a specific set.',
    });
  });

export type DeleteRoutinesInput = z.infer<typeof deleteRoutinesInputSchema>;

export const workerRefSchema = workerRefInputSchema;

export type WorkerRef = z.infer<typeof workerRefSchema>;

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const todoItemSchema = z.object({
  content: z.string().trim().min(1).max(500),
  status: todoStatusSchema,
});

export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemSchema).max(50),
});

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

export const pathInputSchema = z.object({
  path: z.string().min(1),
});

export const readWriteInputSchema = z.object({
  path: z.string().min(1),
  body: z.string(),
});

export const bashInputSchema = z.object({
  command: z.string().min(1),
  ...autoReviewRetryFields,
});

export const xyInputSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const typeTextInputSchema = z.object({
  text: z.string().min(1).max(4000),
});

export const keyInputSchema = z.object({
  key: z.string().min(1),
});

export const urlInputSchema = z.object({
  url: z.string().min(1),
});

export const connectSocialInputSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  /** True to connect for every agent on the account; left out, the connection is this agent's own. */
  forAllAgents: z.boolean().optional(),
  /** True to connect one more account beside those already connected. */
  addAccount: z.boolean().optional(),
  /** True to replace the app keys with new ones. */
  newKeys: z.boolean().optional(),
  /** True to sign accounts out: the one named in `account`, or all of this connection's when none is named. */
  disconnect: z.boolean().optional(),
  /** With disconnect: the username to sign out. */
  account: z.string().optional(),
});

export const computerMemoryInputSchema = z.object({
  action: z.enum(["request", "release", "status"]),
  /** For "request": how much memory the job needs in all, in GB. */
  gb: z.number().min(1).max(512).optional(),
  /** For "request": how long the job may take, in minutes. */
  minutes: z.number().int().min(1).max(180).optional(),
});

export const webSearchInputSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().int().min(1).max(20).optional(),
});

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  include: z.string().optional(),
});

/** open_on_screen: one http(s) page shown in the visible browser on the agent's desktop. */
export const openOnScreenInputSchema = z.object({
  url: z.string().trim().min(4).max(2000),
});

export const browserNavigateInputSchema = z.object({
  url: z.string().min(1),
});

export const browserUidInputSchema = z.object({
  uid: z.string().min(1).max(40),
});

/** ask_agent: one question from a worker to the agent it works for. */
export const askAgentInputSchema = z.object({
  question: z.string().min(8).max(600),
  /** The choices the worker sees, when there are a few. */
  options: z.array(z.string().min(1).max(160)).max(5).optional(),
  /** The one it would choose; used if no answer comes. */
  pick: z.string().max(160).optional(),
});

export const browserClickInputSchema = z.object({
  uid: z.string().min(1).max(40),
  double: z.boolean().optional(),
});

export const browserClickAtInputSchema = z.object({
  x: z.number().min(0).max(10000),
  y: z.number().min(0).max(10000),
});

export const browserDragInputSchema = z.object({
  uid: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
});

export const browserTypeInputSchema = z.object({
  text: z.string().min(1).max(4000),
  /** The field to type into; left out, the keys go to whatever has focus. */
  uid: z.string().max(40).optional(),
  enter: z.boolean().optional(),
});

export const browserCheckInputSchema = z.object({
  uid: z.string().min(1).max(40),
  checked: z.boolean().optional(),
});

export const browserDownloadInputSchema = z.object({
  uid: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
});

export const browserEvalInputSchema = z.object({
  script: z.string().min(1).max(4000),
});

export const browserSnapshotInputSchema = z.object({
  /** Only links, buttons and fields: shorter, for a long page you only need to act on. */
  interactive: z.boolean().optional(),
});

export const browserReadInputSchema = z.object({
  /** A ref from the snapshot to read one part; left out, the whole page's text. */
  uid: z.string().max(40).optional(),
});

export const browserSelectInputSchema = z.object({
  uid: z.string().min(1).max(40),
  value: z.string().min(1).max(300),
});

export const browserSetValueInputSchema = z.object({
  /** The field's name, id or label, as listed under the snapshot. */
  field: z.string().min(1).max(200),
  value: z.string().max(4000),
});

export const browserUploadInputSchema = z.object({
  uid: z.string().min(1).max(40),
  path: z.string().min(1).max(1000),
});

export const browserScrollInputSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pixels: z.number().int().min(50).max(20000).optional(),
});

export const browserTabsInputSchema = z.object({
  action: z.enum(["list", "new", "switch", "close"]),
  tab: z.string().max(10).optional(),
  url: z.string().max(2000).optional(),
});

export const browserFillInputSchema = z.object({
  uid: z.string().min(1).max(40),
  value: z.string().max(4000),
});

export const browserPressKeyInputSchema = z.object({
  key: z.string().min(1).max(40),
});

export const browserDialogInputSchema = z.object({
  accept: z.boolean(),
  promptText: z.string().max(500).optional(),
});

export const browserWaitInputSchema = z.object({
  text: z.string().min(1).max(200),
});
