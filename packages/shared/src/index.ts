export * from "./version.js";
import { z } from "zod";

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const providerNames = ["openai", "anthropic", "xai", "local"] as const;

export const providerKeySchema = z
  .object({
    provider: z.enum(providerNames),
    secret: z.string().max(16_384),
    baseUrl: z.string().url().max(2_048).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "local" && !value.baseUrl) {
      context.addIssue({ code: "custom", message: "A local provider needs a base URL." });
    }
    if (value.provider !== "local" && value.secret.trim().length === 0) {
      context.addIssue({ code: "custom", message: "The API key is required." });
    }
  });

export type ProviderKey = z.infer<typeof providerKeySchema>;

/** Per-account HTTP MCP connector (Streamable MCP URL + optional bearer token). */
export const mcpServerInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "Slug must start with a letter and use lowercase letters, digits, _ or -."),
  url: z.string().url().max(2_048),
  secret: z.string().max(16_384).optional().default(""),
  enabled: z.boolean().optional(),
});

export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

/**
 * Agent identity (Phase 17): role + personality + job.
 * Why: users jammed tone + duties + constraints into one blob and the model
 * deprioritized unpredictably. Three labeled fields compose in fixed order.
 * No backward compatibility — the old `description` field is deleted.
 * Input: raw hire fields. Output: validated identity fragment.
 */
export const agentIdentityInputSchema = z.object({
  role: z.string().trim().min(1).max(100),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().min(1).max(10_000),
});

export type AgentIdentityInput = z.infer<typeof agentIdentityInputSchema>;

/**
 * What an agent is for. `work` does jobs on its own computer, `companion` is
 * for conversation only, `support` is the account's default agent that sets
 * the others up. Each kind has its own standing prompt and tool list.
 */
export const agentKinds = ["work", "companion", "support"] as const;
export type AgentKind = (typeof agentKinds)[number];
/** Kinds a person or an agent may choose. `support` is created by the core only. */
export const hireableAgentKinds = ["work", "companion"] as const;

/** Model suggested for each provider when the person picks the account's default model. */
export const defaultModelIds: Partial<Record<(typeof providerNames)[number], string>> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-5-5",
  xai: "grok-4",
};

const agentCreateFields = z.object({
  name: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  // Role and job may be left out: the agent then asks the person what it is
  // for and writes them itself (see `set_my_profile`).
  role: z.string().trim().max(100).optional().default(""),
  personality: z.string().trim().max(500).optional().default(""),
  jobDescription: z.string().trim().max(10_000).optional().default(""),
  provider: z.enum(providerNames),
  modelId: z.string().trim().min(1).max(200),
  kind: z.enum(hireableAgentKinds).optional().default("work"),
});

export const agentFlagsSchema = z.object({
  notify: z.boolean(),
  pinned: z.boolean(),
  hidden: z.boolean(),
});

/** Dot Avatar Maker classics + cat + robot. */
export const markShapes = [
  "round",
  "triangle",
  "pill",
  "ears",
  "cloud",
  "heart",
  "butterfly",
  "sprout",
  "scallop",
  "hexagon",
  "diamond",
  "cat",
  "robot",
] as const;

export type MarkShape = (typeof markShapes)[number];

/** Dot Avatar Maker finishes. */
export const markMaterials = [
  "plush",
  "longfur",
  "felt",
  "clay",
  "ceramic",
  "crackle",
  "stoneware",
  "pearl",
  "vinyl",
  "jelly",
  "glass",
  "chrome",
] as const;

export type MarkMaterial = (typeof markMaterials)[number];

/** Maps retired mark ids onto the Dot catalog so old rows still render. */
export function normalizeMarkShape(raw: string | null | undefined): MarkShape | null {
  if (!raw) return null;
  const legacy: Record<string, MarkShape> = {
    circle: "round",
    blob: "scallop",
    square: "diamond",
    drop: "heart",
  };
  if (legacy[raw]) return legacy[raw];
  return (markShapes as readonly string[]).includes(raw) ? (raw as MarkShape) : null;
}

export function normalizeMarkMaterial(raw: string | null | undefined): MarkMaterial | null {
  if (!raw) return null;
  return (markMaterials as readonly string[]).includes(raw) ? (raw as MarkMaterial) : null;
}

/** Dot Avatar Maker palette (same order as the studio). */
export const markColorPresets = [
  "#FA70AB",
  "#DD6ADC",
  "#A25BFF",
  "#4778FF",
  "#00B1FF",
  "#04BB9F",
  "#B6D80B",
  "#FFCC38",
  "#FF8066",
] as const;

/** Dot studio outfit ids (gentleman, bow, …). */
export const markStyles = [
  "gentleman",
  "royal",
  "wizard",
  "pirate",
  "detective",
  "ninja",
  "lady",
  "bow",
  "princess",
  "flowercrown",
  "heartshades",
  "kittyphones",
  "witch",
  "sunhat",
  "minimal",
  "artist",
  "scholar",
  "cool",
  "music",
  "outdoor",
  "dreamer",
  "gardener",
  "playful",
  "futuristic",
  "cosmic",
  "chef",
  "astronaut",
  "gamer",
  "athlete",
  "sleepy",
  "sweetheart",
  "flower",
] as const;

export type MarkStyle = (typeof markStyles)[number];

export const markGenders = ["male", "female"] as const;
export type MarkGender = (typeof markGenders)[number];

/** Studio STYLE_GENDER: m/f = boy/girl only; absent = everyone. */
export const markStyleGender: Partial<Record<MarkStyle, "m" | "f">> = {
  gentleman: "m",
  royal: "m",
  wizard: "m",
  pirate: "m",
  detective: "m",
  ninja: "m",
  lady: "f",
  bow: "f",
  princess: "f",
  flowercrown: "f",
  heartshades: "f",
  kittyphones: "f",
  witch: "f",
  sunhat: "f",
  sweetheart: "f",
  flower: "f",
};

export function styleFitsMark(style: MarkStyle, gender: MarkGender): boolean {
  const slot = markStyleGender[style];
  if (!slot) return true;
  return slot === (gender === "female" ? "f" : "m");
}

export function defaultStyleForGender(gender: MarkGender): MarkStyle {
  return gender === "female" ? "lady" : "gentleman";
}

export function defaultGenderForStyle(style: MarkStyle): MarkGender {
  const slot = markStyleGender[style];
  if (slot === "f") return "female";
  if (slot === "m") return "male";
  return "male";
}

export function normalizeMarkStyle(raw: string | null | undefined): MarkStyle | null {
  if (!raw) return null;
  return (markStyles as readonly string[]).includes(raw) ? (raw as MarkStyle) : null;
}

export function normalizeMarkGender(raw: string | null | undefined): MarkGender | null {
  if (!raw) return null;
  return (markGenders as readonly string[]).includes(raw) ? (raw as MarkGender) : null;
}

export type AgentMark = {
  markShape: MarkShape;
  markColor: string;
  markMaterial: MarkMaterial;
  markStyle: MarkStyle;
  markGender: MarkGender;
};

/** Dot studio “Surprise me”: random form, color, material, style, and gender. */
export function randomSurpriseMark(): AgentMark {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
  const markGender: MarkGender = Math.random() < 0.5 ? "female" : "male";
  const fitting = markStyles.filter((id) => styleFitsMark(id, markGender));
  const markStyle = pick(fitting.length > 0 ? fitting : markStyles);
  return {
    markShape: pick(markShapes),
    markMaterial: Math.random() < 0.45 ? "plush" : pick(markMaterials),
    markColor: pick(markColorPresets),
    markStyle,
    markGender,
  };
}

export const agentCreateSchema = agentCreateFields.extend({
  // The look picked on the create form; left out, the agent gets a random one.
  markShape: z.enum(markShapes).optional(),
  markColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Mark color must be a hex color like #FFCC38.")
    .optional(),
  markMaterial: z.enum(markMaterials).optional(),
  markStyle: z.enum(markStyles).optional(),
  markGender: z.enum(markGenders).optional(),
});

export const agentProfileSchema = agentFlagsSchema.extend({
  notify: z.boolean().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  role: z.string().trim().min(1).max(100).optional(),
  personality: z.string().trim().max(500).optional(),
  jobDescription: z.string().trim().min(1).max(10_000).optional(),
  provider: z.enum(providerNames).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  // The app sends the whole profile back, so every kind parses here; the core
  // refuses a change to or from `support`.
  kind: z.enum(agentKinds).optional(),
  markShape: z.enum(markShapes).nullable().optional(),
  markColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Mark color must be a hex color like #FFCC38.")
    .nullable()
    .optional(),
  markMaterial: z.enum(markMaterials).nullable().optional(),
  markStyle: z.enum(markStyles).nullable().optional(),
  markGender: z.enum(markGenders).nullable().optional(),
  avatarUrl: z.string().trim().min(1).max(8_000_000).nullable().optional(),
});

export type Account = z.infer<typeof accountSchema>;
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentFlags = z.infer<typeof agentFlagsSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const roomCreateSchema = z.object({
  kind: z.enum(["direct", "group"]),
  title: z.string().trim().min(1).max(200),
  ownerAgentId: z.string().uuid(),
  memberAgentIds: z.array(z.string().uuid()).max(20),
});

export const messageCreateSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
});

// --- Rich turn protocol (Phase 08): blocks, send_message input, reactions ---

export const textBlockSchema = z.object({
  kind: z.literal("text"),
  markdown: z.string().min(1).max(100_000),
});

export const blobRefSchema = z.object({
  messageId: z.string().uuid(),
  index: z.number().int().min(0).max(9),
});

export const imageBlockSchema = z.object({
  kind: z.literal("image"),
  // https URL or data:image/*;base64 URI (capped to keep rows + prompts bounded).
  url: z.string().min(1).max(8_000_000),
  alt: z.string().max(500).optional(),
  // Filled server-side when a data: URI is materialized onto the account
  // Linux: the agent opens/copies this path instead of the raw base64.
  savedPath: z.string().max(500).optional(),
  // Small resized data URI for vision grounding (full file stays on disk).
  previewUrl: z.string().max(1_000_000).optional(),
  // Set by listMessages when url/previewUrl exceed the inline budget: the
  // client fetches the bytes lazily from the blob endpoint instead.
  blobRef: blobRefSchema.optional(),
});

export const codeBlockSchema = z.object({
  kind: z.literal("code"),
  language: z.string().max(50).optional(),
  code: z.string().min(1).max(100_000),
});

export const fileBlockSchema = z.object({
  kind: z.literal("file"),
  // https URL or small data: URI (text, pdf, json — capped like images so a
  // phone attachment cannot blow up the row or the prompt).
  url: z.string().min(1).max(8_000_000),
  name: z.string().min(1).max(255),
  mime: z.string().max(127).optional(),
  // Filled server-side when a data: URI is materialized onto the account Linux.
  savedPath: z.string().max(500).optional(),
  // Set by listMessages when url exceeds the inline budget (see blobRefSchema).
  blobRef: blobRefSchema.optional(),
  // A file too large to hold in the message: it stays on the agent's computer
  // at savedPath and is streamed from there on request. Set by the core only.
  remote: z.boolean().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const widgetBlockSchema = z.object({
  kind: z.literal("widget"),
  widget: z.enum([
    "checklist",
    "chart",
    "approval",
    "agent-card",
    "poll",
    "table",
    "secret",
    "question",
    "desktop-handover",
  ]),
  // Loose bag of widget fields. catchall (not z.record) so OpenAI JSON Schema
  // never gets propertyNames — OpenAI rejects that keyword and AI SDK warns.
  props: z.object({}).catchall(z.unknown()),
});

/** Name rule for vault secrets: env-var shaped, so agents can ask for ENV_NAME. */
export const secretNameRegex = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const secretInputSchema = z.object({
  name: z.string().trim().min(1).max(128).regex(secretNameRegex, "Secret name must look like an ENV_VAR."),
  secret: z.string().min(1).max(16_384),
});

export type SecretInput = z.infer<typeof secretInputSchema>;

export const messageBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema,
  imageBlockSchema,
  codeBlockSchema,
  fileBlockSchema,
  widgetBlockSchema,
]);

export type MessageBlock = z.infer<typeof messageBlockSchema>;

export const sendMessageInputSchema = z
  .object({
    blocks: z.array(messageBlockSchema).min(1).max(10),
    replyTo: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    const textChars = value.blocks
      .filter((block) => block.kind === "text")
      .map((block) => (block as { markdown: string }).markdown.length)
      .reduce((sum, length) => sum + length, 0);
    if (textChars > 100_000) {
      context.addIssue({ code: "custom", message: "Text blocks exceed 100k chars." });
    }
  });

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

const WIDGET_MARKUP =
  /\[widget:([a-z][a-z0-9_-]*)\s*(\{(?:[^{}]|\{[^{}]*\})*\})?\s*\]/gi;

/**
 * Rewrites a secret widget a model typed out in words, `(widget: secret envName=API_KEY label="API key")`,
 * into the bracket form the expander below understands.
 * Why: asked for a secret widget, a model sometimes writes this line into its
 * text. The person then saw a line of code and no field to type into, and
 * the only way forward was to paste the secret into the chat.
 */
function secretNotesAsMarkup(markdown: string): string {
  return markdown.replace(/\(\s*widget:\s*secret\b([^)\n]*)\)/gi, (whole, rest: string) => {
    const props: Record<string, string> = {};
    for (const pair of rest.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) {
      props[pair[1]!] = pair[2] ?? pair[3] ?? pair[4] ?? "";
    }
    if (!props.envName || !secretNameRegex.test(props.envName)) return whole;
    if (props.label && !props.title) props.title = props.label;
    return `[widget:secret ${JSON.stringify(props)}]`;
  });
}

/**
 * Turns markdown that looks like `[widget:secret {…}]` into real widget blocks.
 * Why: models sometimes dump the widget as text; the phone then shows code.
 */
export function expandWidgetMarkupBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      out.push(block);
      continue;
    }
    const row = block as Record<string, unknown>;
    if (row.kind === "widget") {
      out.push(block);
      continue;
    }
    if (row.kind !== "text" || typeof row.markdown !== "string") {
      out.push(block);
      continue;
    }
    const markdown = secretNotesAsMarkup(row.markdown);
    if (!/\[widget:/i.test(markdown)) {
      out.push(block);
      continue;
    }
    let last = 0;
    let matched = false;
    WIDGET_MARKUP.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = WIDGET_MARKUP.exec(markdown)) !== null) {
      matched = true;
      const before = markdown.slice(last, hit.index).trim();
      if (before) out.push({ kind: "text", markdown: before });
      const widget = hit[1]!.toLowerCase();
      let props: Record<string, unknown> = {};
      if (hit[2]) {
        try {
          props = JSON.parse(hit[2]) as Record<string, unknown>;
        } catch {
          props = {};
        }
      }
      out.push({ kind: "widget", widget, props });
      last = hit.index + hit[0].length;
    }
    if (!matched) {
      out.push(block);
      continue;
    }
    const after = markdown.slice(last).trim();
    if (after) out.push({ kind: "text", markdown: after });
  }
  return out;
}

/**
 * Parses one markdown string that may be a dumped widget into blocks.
 * Why: already-saved rows still show raw markup until re-expanded on read.
 */
export function blocksFromMaybeWidgetText(markdown: string): MessageBlock[] {
  return expandWidgetMarkupBlocks([{ kind: "text", markdown }]) as MessageBlock[];
}

export const allowedEmojis = ["👍", "❤️", "👀", "🚀", "😮", "🎉", "✅", "❌"] as const;

export type RoomCreate = z.infer<typeof roomCreateSchema>;
export type MessageCreate = z.infer<typeof messageCreateSchema>;

export const memberAddSchema = z.object({
  agentId: z.string().uuid(),
});

export type MemberAdd = z.infer<typeof memberAddSchema>;

export const summaryKeySchema = z.enum(["decisions", "actions", "open", "entities", "corrections", "topics"]);

export const summaryItemSchema = z.object({
  key: summaryKeySchema,
  body: z.string().min(1),
  messageId: z.string().uuid(),
});

export const memoryFactSchema = z
  .object({
    scope: z.enum(["agent", "user"]),
    agentId: z.string().uuid().nullable(),
    body: z.string().min(1),
    messageId: z.string().uuid(),
  })
  .superRefine((fact, context) => {
    if (fact.scope === "user" && fact.agentId !== null) {
      context.addIssue({ code: "custom", message: "A user fact has no agent." });
    }
    if (fact.scope === "agent" && fact.agentId === null) {
      context.addIssue({ code: "custom", message: "An agent fact needs an agent." });
    }
  });

export const memoryCorrectSchema = z
  .object({
    scope: z.enum(["agent", "user"]),
    agentId: z.string().uuid().nullable(),
    oldBody: z.string().min(1),
    body: z.string().min(1),
    messageId: z.string().uuid(),
  })
  .superRefine((fact, context) => {
    if (fact.scope === "user" && fact.agentId !== null) {
      context.addIssue({ code: "custom", message: "A user fact has no agent." });
    }
    if (fact.scope === "agent" && fact.agentId === null) {
      context.addIssue({ code: "custom", message: "An agent fact needs an agent." });
    }
  });

export type SummaryItem = z.infer<typeof summaryItemSchema>;
export type MemoryFact = z.infer<typeof memoryFactSchema>;
export type MemoryCorrect = z.infer<typeof memoryCorrectSchema>;

export const proposalSchema = z
  .object({
    agentId: z.string().uuid(),
    kind: z.enum(["memory", "skill", "prompt"]),
    body: z.string().min(1),
    messageIds: z.array(z.string().uuid()),
  })
  .superRefine((proposal, context) => {
    if (proposal.messageIds.length === 0) {
      context.addIssue({ code: "custom", message: "A proposal needs a message id." });
    }
  });

export type ProposalInput = z.infer<typeof proposalSchema>;

export const routineSchema = z.object({
  agentId: z.string().uuid(),
  conversationId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().min(1),
  cron: z.string().min(1),
  nextRunAt: z.string().min(1).optional(),
});

export type RoutineInput = z.infer<typeof routineSchema>;

// --- Runs, events, notify (Phases 11-14) ---

export const runKindSchema = z.enum(["turn", "routine"]);

export const runStatusSchema = z.enum(["running", "done", "failed"]);

export const urgencySchema = z.enum(["info", "action-needed"]);

export const deviceSchema = z.object({
  expoPushToken: z.string().trim().min(1).max(500),
  platform: z.enum(["ios", "android", "web"]).nullable().optional(),
  /** One id per install of the app, so a reinstall or a new token replaces the old row. */
  installId: z.string().trim().min(8).max(100).optional(),
});

export type DeviceInput = z.infer<typeof deviceSchema>;

export const eventTypeSchema = z.enum(["message", "reaction", "run", "error", "notify"]);

export const defaultModelSchema = z.object({
  provider: z.enum(providerNames),
  modelId: z.string().trim().min(1).max(200),
});
export type DefaultModel = z.infer<typeof defaultModelSchema>;

// --- Chart widget ---

export const chartTypes = ["bar", "line", "pie"] as const;
export type ChartType = (typeof chartTypes)[number];
export type ChartData = {
  type: ChartType;
  title: string;
  /** One label per point: a category, a date, a slice name. */
  labels: string[];
  /** One or more sets of values, each as long as `labels`. A pie uses the first. */
  series: { name: string; values: number[] }[];
  /** Shown with every value: "$", "%", "ms". Currency signs go in front. */
  unit: string;
};

const MAX_CHART_POINTS = 60;
const MAX_CHART_SERIES = 6;

/**
 * Reads a chart widget's props into one clean shape, or null when there is nothing to draw.
 * Why: the core checks a chart before sending it and the phone draws it, and
 * both must agree on what counts as valid. Models also write the same chart
 * several ways (`values`, `series`, or `data` as label/value pairs), so every
 * common form is accepted here instead of bouncing the call.
 * Input: the widget's props. Output: the chart, or null.
 */
export function chartData(props: Record<string, unknown>): ChartData | null {
  const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? Number(entry) : entry)).filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) : [];
  const type = chartTypes.find((name) => name === text(props.type).toLowerCase()) ?? "bar";
  let labels = Array.isArray(props.labels) ? props.labels.map(text) : [];
  let series: ChartData["series"] = [];
  if (Array.isArray(props.series)) {
    series = props.series
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({ name: text(entry.name) || text(entry.label), values: numbers(entry.values ?? entry.data) }));
  } else if (Array.isArray(props.values)) {
    series = [{ name: "", values: numbers(props.values) }];
  }
  // `data: [{ label, value }]`, the other shape models reach for.
  const pairs = Array.isArray(props.data) ? props.data.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
  if (series.length === 0 && pairs.length > 0) {
    labels = pairs.map((entry) => text(entry.label) || text(entry.name) || text(entry.x));
    series = [{ name: "", values: pairs.map((entry) => Number(entry.value ?? entry.y)).map((value) => (Number.isFinite(value) ? value : 0)) }];
  }
  series = series.filter((entry) => entry.values.length > 0).slice(0, MAX_CHART_SERIES);
  const points = Math.min(MAX_CHART_POINTS, Math.max(0, ...series.map((entry) => entry.values.length)));
  if (points === 0) return null;
  return {
    type,
    title: text(props.title),
    labels: Array.from({ length: points }, (_unused, index) => labels[index] || String(index + 1)),
    // Short series are padded so every one lines up with the labels.
    series: series.map((entry) => ({ name: entry.name, values: Array.from({ length: points }, (_unused, index) => entry.values[index] ?? 0) })),
    unit: text(props.unit).slice(0, 6),
  };
}

/** A value as a chart shows it: short, with the unit ("$1.2k", "45%", "3.4M"). */
export function chartValue(value: number, unit = ""): string {
  const size = Math.abs(value);
  const short =
    size >= 1_000_000_000 ? `${trimNumber(value / 1_000_000_000)}B`
    : size >= 1_000_000 ? `${trimNumber(value / 1_000_000)}M`
    : size >= 10_000 ? `${trimNumber(value / 1_000)}k`
    : trimNumber(value);
  if (!unit) return short;
  return /^[$€£¥₹]$/.test(unit) ? (value < 0 ? `-${unit}${short.slice(1)}` : `${unit}${short}`) : `${short}${unit.length > 1 ? " " : ""}${unit}`;
}

function trimNumber(value: number): string {
  const size = Math.abs(value);
  return String(Number(value.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)));
}

/**
 * Round numbers for a chart's value axis.
 * Input: the lowest and highest value, and whether the axis must include zero
 * (bars are measured from it; a line may start higher so a trend stays visible).
 * Output: the axis ends and the values to draw a line at, three or four of them.
 */
export function chartScale(low: number, high: number, fromZero = true): { min: number; max: number; ticks: number[] } {
  const bottom = fromZero ? Math.min(0, low) : low;
  const top = fromZero ? Math.max(0, high) : high;
  const span = top - bottom || Math.abs(top) || 1;
  const rough = span / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((size) => size >= rough) ?? rough;
  const min = Math.floor(bottom / step) * step;
  let max = Math.ceil(top / step) * step;
  if (max === min) max = min + step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { min: Number(min.toPrecision(12)), max: Number(max.toPrecision(12)), ticks };
}
