import {
  agentCreateSchema,
  agentProfileSchema,
  messageCreateSchema,
  roomCreateSchema,
  type AgentKind,
  type AgentMark,
  type AgentProfile,
  type MarkGender,
  type MarkMaterial,
  type MarkShape,
  type MarkStyle,
  type MessageBlock,
} from "@kuru/shared";
import { coreBaseUrl } from "./core-url";

export type { MessageBlock };

export type RichMessage = {
  id: string;
  agentId: string | null;
  body: string;
  kind?: string | null;
  payload?: MessageBlock[] | null;
  replyTo?: string | null;
  viaAgentId?: string | null;
  sourceConversationId?: string | null;
  relayKind?: "from" | "to" | null;
  relayPeers?: { id: string; label: string }[] | null;
  createdAt: string;
};

export type Reaction = {
  id: string;
  messageId: string;
  agentId: string | null;
  emoji: string;
};

export type ProviderSetting = {
  provider: "openai" | "anthropic" | "xai" | "local";
  baseUrl: string | null;
  configured: boolean;
  /** Set on save when the server could not be checked (it has no model list). */
  note?: string;
};

export type RosterAgent = {
  id: string;
  name: string;
  label: string;
  role: string;
  personality: string;
  jobDescription: string;
  /** What the agent is for. `support` is the account's default agent. */
  kind: AgentKind;
  provider: ProviderSetting["provider"];
  modelId: string;
  linuxProfile: string | null;
  notify: boolean;
  pinned: boolean;
  hidden: boolean;
  markShape: MarkShape | null;
  markColor: string | null;
  markMaterial: MarkMaterial | null;
  markStyle: MarkStyle | null;
  markGender: MarkGender | null;
  avatarUrl: string | null;
};

export type Proposal = {
  id: string;
  agentId: string;
  kind: string;
  body: string;
  status: string;
};

export type ToolApproval = {
  id: string;
  agentId: string;
  conversationId: string;
  tool: string;
  summary: string;
  status: string;
  /** False for a shell command or removing an agent, which always ask. */
  canAlwaysAllow?: boolean;
};

/** "Always allow": an action one agent may take without asking again. */
export type ToolAllowance = { id: string; tool: string; label: string; agentId: string; agentName: string; createdAt: string };

export type AccountSettings = {
  autoReview: boolean;
  timezone: string;
  /** The model new agents start on; null until setup is finished. */
  defaultModel?: DefaultModelSetting | null;
  /** The cheaper model background work runs on; null when unset. */
  cheapModel?: DefaultModelSetting | null;
};

export type DefaultModelSetting = { provider: ProviderSetting["provider"]; modelId: string };

export type PluginCard = {
  id: string;
  name: string;
  description: string;
  section: string;
  kind: "google" | "remote";
  mark: { icon: string | null; letter: string; color: string };
  skills: { name: string; description: string }[];
  installed: boolean;
  configured: boolean;
  lastError: string | null;
};

export type PluginList = { installed: number; plugins: PluginCard[] };

export type RoutineRun = {
  id: string;
  status: "done" | "failed" | string;
  runAt: string;
};

export type Routine = {
  id: string;
  title: string;
  instructions: string;
  cron: string;
  timezone: string;
  paused: boolean;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastRunStatus?: "done" | "failed" | null;
  conversationId?: string;
  recentRuns?: RoutineRun[];
};

export type RoutineInput = {
  conversationId: string;
  title: string;
  instructions: string;
  cron: string;
  timezone?: string;
};

export type RoutinePatch = {
  title?: string;
  instructions?: string;
  cron?: string;
  timezone?: string;
  paused?: boolean;
};

export type ChatContextInfo = {
  conversationId: string;
  counts: { messages: number; summaryItems: number; runs: number; runsDone: number; delegationsRunning: number; delegationsDone: number };
  context: { prefixChars: number; tailChars: number; toolCount: number; estTokens: number; recentWindow: number; summaryWindow: number };
  usage: {
    runsTracked: number;
    runsUntracked: number;
    delegationsTracked: number;
    delegationsUntracked: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    lastRuns: { id: string; status: string; inputTokens: number | null; outputTokens: number | null; modelSteps: number | null; createdAt: string }[];
  };
  model: {
    provider: string;
    modelId: string;
    contextWindow: number | null;
    capacitySource: "gateway" | "plugin" | "builtin-estimate" | "unknown";
    estTurnShare: number | null;
  };
};

/** Compact token counts for the chat header (ctx window vs lifetime billing). */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function formatWindowSharePct(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** Header line: how full the context window is (matches the composer ring). */
export function contextLine(info: ChatContextInfo): string {
  const share = contextUsageShare(info);
  const ctx = formatTokenCount(info.context.estTokens);
  const parts: string[] = [];
  const window = info.model.contextWindow;
  if (window && window > 0) {
    parts.push(`${formatWindowSharePct(share)} · ${ctx} of ${formatTokenCount(window)} window`);
  } else {
    parts.push(`${ctx} est ctx`);
  }
  // Hidden for now: the lifetime total and the untracked count read as a bill
  // and a fault next to the window figure, and the Usage page now carries both.
  // const billed = info.usage.totalTokens;
  // if (billed > 0) {
  //   parts.push(`${formatTokenCount(billed)} billed`);
  // }
  // const untrackedCount = info.usage.runsUntracked + info.usage.delegationsUntracked;
  // if (untrackedCount > 0) {
  //   parts.push(`+${untrackedCount} untracked`);
  // }
  return parts.join(" · ");
}

/** Normalized 0–1 fill for the composer ring — same ratio as the header window %. */
export function contextUsageShare(info: ChatContextInfo): number {
  const window = info.model.contextWindow;
  if (!window || window <= 0) return 0;
  const share = info.context.estTokens / window;
  return Math.min(1, Math.max(0, share));
}

export type MessagePage = { limit?: number; before?: string };

export type StreamEvent = {
  type: string;
  message?: RichMessage;
  reaction?: Reaction;
  notification?: PendingNotification;
  run?: { id: string; status: string; error?: string | null };
  error?: string;
  cursor?: number;
};

export type PendingNotification = {
  id: string;
  conversationId: string;
  messageId: string | null;
  runId: string | null;
  title: string;
  body: string;
  urgency: string;
  createdAt: string;
};

type UsageTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; turns: number; jobs: number };
/** The windows the Usage page offers. */
export type UsagePeriod = "today" | "week" | "month";
/** What the account's agents used in a period: by hour (today) or day, by agent and by model. */
export type AccountUsage = {
  period: UsagePeriod;
  timezone: string;
  /** What one bar covers. */
  bucket: "hour" | "day";
  totals: UsageTotals;
  /** `key` is "HH" for an hour or "YYYY-MM-DD" for a day; `models` is tokens per model key. */
  series: ({ key: string; models: Record<string, number> } & UsageTotals)[];
  agents: ({ agentId: string; name: string; provider: string; modelId: string } & UsageTotals)[];
  /** `key` is "provider/model". */
  models: ({ key: string; provider: string; modelId: string } & UsageTotals)[];
};

/** What the inbox list shows beside each chat. */
export type InboxStatus = {
  rooms: { id: string; kind: string; ownerAgentId: string; unread: number; working: boolean }[];
  /** Agents with a turn or background work running. */
  workingAgentIds: string[];
};

export type CoreClient = {
  listAgents: (accountId: string) => Promise<RosterAgent[]>;
  hireAgent: (
    accountId: string,
    input: { name: string; role?: string; personality?: string; jobDescription?: string; kind?: "work" | "companion"; provider: ProviderSetting["provider"]; modelId: string; look?: AgentMark },
  ) => Promise<RosterAgent>;
  hireSubagent: (
    accountId: string,
    parentAgentId: string,
    conversationId: string,
    input: { label: string; role: string; personality?: string; jobDescription: string },
  ) => Promise<RosterAgent>;
  listTeam: (accountId: string, agentId: string) => Promise<RosterAgent[]>;
  listProviders: (accountId: string) => Promise<ProviderSetting[]>;
  listPlugins: (accountId: string) => Promise<PluginList>;
  startGooglePlugin: (accountId: string, id: string) => Promise<{ installed: true } | { installed: false; url: string }>;
  startMcpPlugin: (accountId: string, slug: string, url: string) => Promise<{ url: string }>;
  saveMcpPlugin: (accountId: string, input: { slug: string; url: string; secret: string }) => Promise<unknown>;
  deleteMcpPlugin: (accountId: string, slug: string) => Promise<void>;
  saveProvider: (
    accountId: string,
    input: { provider: ProviderSetting["provider"]; secret: string; baseUrl: string | null },
  ) => Promise<ProviderSetting>;
  listConversations: (accountId: string) => Promise<{ id: string; kind: string; title: string; ownerAgentId: string; brief?: string | null }[]>;
  listMembers: (accountId: string, conversationId: string) => Promise<{ agentId: string }[]>;
  chatContext: (accountId: string, conversationId: string) => Promise<ChatContextInfo>;
  /** The whole thread, or with a page: the newest `limit` messages, or the `limit` just before one message. */
  listMessages: (accountId: string, conversationId: string, page?: MessagePage) => Promise<RichMessage[]>;
  blob: (accountId: string, conversationId: string, messageId: string, index: number) => Promise<{
    url?: string;
    previewUrl?: string;
  }>;
  listReactions: (accountId: string, conversationId: string) => Promise<Reaction[]>;
  react: (accountId: string, conversationId: string, messageId: string, emoji: string) => Promise<Reaction>;
  upload: (accountId: string, input: { url: string; name?: string; mime?: string | null }) => Promise<{ url: string }>;
  openChat: (accountId: string, agent: RosterAgent) => Promise<{ id: string }>;
  createGroup: (accountId: string, title: string, agentIds: string[]) => Promise<{ id: string }>;
  sendMessage: (
    accountId: string,
    conversationId: string,
    body: string,
    rich?: { blocks?: MessageBlock[]; replyTo?: string | null },
  ) => Promise<{ accepted: boolean; message: RichMessage; replies?: { id: string; body: string }[] }>;
  subscribeMessages: (
    accountId: string,
    conversationId: string,
    onEvent: (event: StreamEvent) => void,
    opts?: { cursor?: number },
  ) => () => void;
  registerDevice: (accountId: string, input: { expoPushToken: string; platform?: string | null; installId?: string }) => Promise<{ id: string }>;
  listNotifications: (accountId: string) => Promise<PendingNotification[]>;
  /** Deletes the account and everything it owns on the server, for good. */
  deleteAccount: (accountId: string) => Promise<void>;
  /** Tokens, turns and background jobs for the last 7, 30 or 90 days. */
  usage: (accountId: string, period: UsagePeriod) => Promise<AccountUsage>;
  /** Unread counts and busy agents for the inbox list. */
  inboxStatus: (accountId: string) => Promise<InboxStatus>;
  /** Tells the server the person has this chat open, so its messages count as seen. */
  markRead: (accountId: string, conversationId: string) => Promise<unknown>;
  ackNotification: (accountId: string, notificationId: string) => Promise<{ id: string }>;
  mention: (draft: string, name: string) => string;
  listProposals: (accountId: string) => Promise<Proposal[]>;
  approve: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  reject: (accountId: string, proposalId: string) => Promise<Proposal[]>;
  getSettings: (accountId: string) => Promise<AccountSettings>;
  setAutoReview: (accountId: string, autoReview: boolean) => Promise<AccountSettings>;
  setDefaultModel: (accountId: string, model: DefaultModelSetting) => Promise<DefaultModelSetting>;
  /** Saves the cheap model, or clears it with null. */
  setCheapModel: (accountId: string, model: DefaultModelSetting | null) => Promise<DefaultModelSetting | null>;
  /** Asks a new chat's agent to write its first message. */
  sayHello: (accountId: string, conversationId: string) => Promise<unknown>;
  rememberTimezone: (accountId: string, timezone: string) => Promise<AccountSettings>;
  listToolApprovals: (accountId: string) => Promise<ToolApproval[]>;
  /** `always`: this agent may take this action from now on without asking. */
  approveTool: (accountId: string, approvalId: string, always?: boolean) => Promise<ToolApproval[]>;
  listAllowances: (accountId: string) => Promise<ToolAllowance[]>;
  removeAllowance: (accountId: string, allowanceId: string) => Promise<ToolAllowance[]>;
  denyTool: (accountId: string, approvalId: string) => Promise<ToolApproval[]>;
  saveProfile: (accountId: string, agentId: string, profile: AgentProfile) => Promise<RosterAgent>;
  saveSecret: (accountId: string, input: { name: string; secret: string }) => Promise<{ name: string; configured: boolean }>;
  wakeCue: (
    accountId: string,
    conversationId: string,
    input: { cue: string; messageId?: string; selected?: string },
  ) => Promise<{ accepted: boolean }>;
  listRoutines: (accountId: string, agentId: string) => Promise<Routine[]>;
  listRoutineRuns: (accountId: string, agentId: string, routineId: string) => Promise<RoutineRun[]>;
  createRoutine: (accountId: string, agentId: string, input: RoutineInput) => Promise<Routine>;
  updateRoutine: (accountId: string, agentId: string, routineId: string, input: RoutinePatch) => Promise<Routine>;
  deleteRoutine: (accountId: string, agentId: string, routineId: string) => Promise<void>;
  screenUrl: (accountId: string, profile: string, token?: string) => string;
  screenPageUrl: (accountId: string, profile: string) => string;
  getScreenToken: (accountId: string, profile: string) => Promise<{ token: string }>;
  takeOver: (accountId: string, profile: string) => Promise<void>;
  handBack: (accountId: string, profile: string) => Promise<void>;
};

let readAuthCookie = (): string => "";

/**
 * Connects normal core requests to Better Auth's secure cookie store.
 * Input: a function supplied by the Expo auth client.
 * Output: nothing. Future API calls carry the signed session cookie.
 */
export function configureAuthCookie(reader: () => string): void {
  readAuthCookie = reader;
}

/**
 * Builds the phone's client for the core HTTP API.
 * Input: an optional core base URL, and an optional fetch implementation.
 * Output: roster, chat, and mention helpers. The client never talks to Docker.
 */
export function createCore(baseUrl?: string, fetchImpl: typeof fetch = fetch): CoreClient {
  if (baseUrl !== undefined) return buildCore(baseUrl, fetchImpl);
  // No address given: follow the one in force, which the person can change on
  // the sign-in screen. Screens keep one client for their whole life, so the
  // lookup happens on each call, not once.
  const built = new Map<string, CoreClient>();
  return new Proxy({} as CoreClient, {
    get(_target, property) {
      const url = coreBaseUrl();
      let client = built.get(url);
      if (!client) built.set(url, (client = buildCore(url, fetchImpl)));
      return client[property as keyof CoreClient];
    },
  });
}

function buildCore(baseUrl: string, fetchImpl: typeof fetch): CoreClient {
  return {
    listAgents: (accountId) => listAgents(baseUrl, accountId, fetchImpl),
    hireAgent: (accountId, input) => hireAgent(baseUrl, accountId, input, fetchImpl),
    hireSubagent: (accountId, parentAgentId, conversationId, input) =>
      hireSubagent(baseUrl, accountId, parentAgentId, conversationId, input, fetchImpl),
    listTeam: (accountId, agentId) => listTeam(baseUrl, accountId, agentId, fetchImpl),
    listProviders: (accountId) => listProviders(baseUrl, accountId, fetchImpl),
    saveProvider: (accountId, input) => saveProvider(baseUrl, accountId, input, fetchImpl),
    listPlugins: (accountId) => listPlugins(baseUrl, accountId, fetchImpl),
    startGooglePlugin: (accountId, id) => startGooglePlugin(baseUrl, accountId, id, fetchImpl),
    startMcpPlugin: (accountId, slug, url) => startMcpPlugin(baseUrl, accountId, slug, url, fetchImpl),
    saveMcpPlugin: (accountId, input) => saveMcpPlugin(baseUrl, accountId, input, fetchImpl),
    deleteMcpPlugin: (accountId, slug) => deleteMcpPlugin(baseUrl, accountId, slug, fetchImpl),
    listConversations: (accountId) => listConversations(baseUrl, accountId, fetchImpl),
    listMembers: (accountId, conversationId) => listMembers(baseUrl, accountId, conversationId, fetchImpl),
    chatContext: (accountId, conversationId) => chatContext(baseUrl, accountId, conversationId, fetchImpl),
    listMessages: (accountId, conversationId, page) => listMessages(baseUrl, accountId, conversationId, fetchImpl, page),
    blob: (accountId, conversationId, messageId, index) =>
      fetchBlob(baseUrl, accountId, conversationId, messageId, index, fetchImpl),
    listReactions: (accountId, conversationId) => listReactions(baseUrl, accountId, conversationId, fetchImpl),
    react: (accountId, conversationId, messageId, emoji) =>
      react(baseUrl, accountId, conversationId, messageId, emoji, fetchImpl),
    upload: (accountId, input) => upload(baseUrl, accountId, input, fetchImpl),
    openChat: (accountId, agent) => openChat(baseUrl, accountId, agent, fetchImpl),
    createGroup: (accountId, title, agentIds) => createGroup(baseUrl, accountId, title, agentIds, fetchImpl),
    sendMessage: (accountId, conversationId, body, rich) =>
      sendMessage(baseUrl, accountId, conversationId, body, rich, fetchImpl),
    subscribeMessages: (accountId, conversationId, onEvent, opts) =>
      subscribeMessages(baseUrl, accountId, conversationId, onEvent, fetchImpl, opts),
    registerDevice: (accountId, input) => registerDevice(baseUrl, accountId, input, fetchImpl),
    listNotifications: (accountId) => listNotifications(baseUrl, accountId, fetchImpl),
    deleteAccount: async (accountId) => {
      await readJson<unknown>(fetchImpl, `${baseUrl}/accounts/${accountId}`, { method: "DELETE" });
    },
    usage: (accountId, period) => readJson<AccountUsage>(fetchImpl, `${baseUrl}/accounts/${accountId}/usage?period=${period}`),
    inboxStatus: (accountId) => readJson<InboxStatus>(fetchImpl, `${baseUrl}/accounts/${accountId}/inbox`),
    markRead: (accountId, conversationId) =>
      readJson<unknown>(fetchImpl, `${baseUrl}/conversations/${conversationId}/read?accountId=${accountId}`, { method: "POST" }),
    ackNotification: (accountId, notificationId) => ackNotification(baseUrl, accountId, notificationId, fetchImpl),
    mention,
    listProposals: (accountId) => listProposals(baseUrl, accountId, fetchImpl),
    approve: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "approve", fetchImpl),
    reject: (accountId, proposalId) => decide(baseUrl, accountId, proposalId, "reject", fetchImpl),
    getSettings: (accountId) => getSettings(baseUrl, accountId, fetchImpl),
    setAutoReview: (accountId, autoReview) => setAutoReview(baseUrl, accountId, autoReview, fetchImpl),
    sayHello: (accountId, conversationId) =>
      readJson<unknown>(fetchImpl, `${baseUrl}/conversations/${conversationId}/hello?accountId=${accountId}`, { method: "POST" }),
    setDefaultModel: (accountId, model) =>
      readJson<DefaultModelSetting>(fetchImpl, `${baseUrl}/accounts/${accountId}/default-model`, {
        method: "PUT",
        body: JSON.stringify(model),
      }),
    setCheapModel: (accountId, model) =>
      readJson<DefaultModelSetting | null>(fetchImpl, `${baseUrl}/accounts/${accountId}/cheap-model`, {
        method: "PUT",
        // An empty object clears it: the server's JSON parser refuses a bare null.
        body: JSON.stringify(model ?? {}),
      }),
    rememberTimezone: (accountId, timezone) => rememberTimezone(baseUrl, accountId, timezone, fetchImpl),
    listToolApprovals: (accountId) => listToolApprovals(baseUrl, accountId, fetchImpl),
    approveTool: (accountId, approvalId, always) => decideTool(baseUrl, accountId, approvalId, always ? "approve?always=1" : "approve", fetchImpl),
    listAllowances: (accountId) => readJson<ToolAllowance[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/tool-allowances`),
    removeAllowance: (accountId, allowanceId) =>
      readJson<ToolAllowance[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/tool-allowances/${allowanceId}`, { method: "DELETE" }),
    denyTool: (accountId, approvalId) => decideTool(baseUrl, accountId, approvalId, "deny", fetchImpl),
    saveProfile: (accountId, agentId, profile) => saveProfile(baseUrl, accountId, agentId, profile, fetchImpl),
    saveSecret: (accountId, input) => saveSecret(baseUrl, accountId, input, fetchImpl),
    wakeCue: (accountId, conversationId, input) => wakeCue(baseUrl, accountId, conversationId, input, fetchImpl),
    listRoutines: (accountId, agentId) => listRoutines(baseUrl, accountId, agentId, fetchImpl),
    listRoutineRuns: (accountId, agentId, routineId) =>
      listRoutineRuns(baseUrl, accountId, agentId, routineId, fetchImpl),
    createRoutine: (accountId, agentId, input) => createRoutine(baseUrl, accountId, agentId, input, fetchImpl),
    updateRoutine: (accountId, agentId, routineId, input) =>
      updateRoutine(baseUrl, accountId, agentId, routineId, input, fetchImpl),
    deleteRoutine: (accountId, agentId, routineId) => deleteRoutine(baseUrl, accountId, agentId, routineId, fetchImpl),
    screenUrl: (accountId, profile, token) => screenUrl(baseUrl, accountId, profile, token),
    screenPageUrl: (accountId, profile) => screenPageUrl(baseUrl, accountId, profile),
    getScreenToken: (accountId, profile) => getScreenToken(baseUrl, accountId, profile, fetchImpl),
    takeOver: (accountId, profile) => screenFlag(baseUrl, accountId, profile, "takeover", fetchImpl),
    handBack: (accountId, profile) => screenFlag(baseUrl, accountId, profile, "handback", fetchImpl),
  };
}

/**
 * Loads provider configuration without exposing secrets.
 * Input: the core base URL, the account id, and fetch.
 * Output: configured provider names and local base URLs.
 */
async function listProviders(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<ProviderSetting[]> {
  return readJson<ProviderSetting[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/providers`);
}

/** Loads this account's plugin catalog. Secrets are never included. */
async function listPlugins(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<PluginList> {
  return readJson<PluginList>(fetchImpl, `${baseUrl}/accounts/${accountId}/plugins`);
}

async function startGooglePlugin(
  baseUrl: string,
  accountId: string,
  id: string,
  fetchImpl: typeof fetch,
): Promise<{ installed: true } | { installed: false; url: string }> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/plugins/google/start`, {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

async function startMcpPlugin(baseUrl: string, accountId: string, slug: string, url: string, fetchImpl: typeof fetch): Promise<{ url: string }> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/plugins/mcp/oauth/start`, {
    method: "POST",
    body: JSON.stringify({ slug, url }),
  });
}

async function saveMcpPlugin(
  baseUrl: string,
  accountId: string,
  input: { slug: string; url: string; secret: string },
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/mcp`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

async function deleteMcpPlugin(baseUrl: string, accountId: string, slug: string, fetchImpl: typeof fetch): Promise<void> {
  const cookie = readAuthCookie();
  const response = await fetchImpl(`${baseUrl}/accounts/${accountId}/mcp/${slug}`, {
    method: "DELETE",
    credentials: "omit",
    headers: { ...(cookie ? { cookie } : {}) },
  });
  if (!response.ok && response.status !== 204) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `Core returned ${response.status}.`);
  }
}

async function saveProvider(
  baseUrl: string,
  accountId: string,
  input: { provider: ProviderSetting["provider"]; secret: string; baseUrl: string | null },
  fetchImpl: typeof fetch,
): Promise<ProviderSetting> {
  return readJson<ProviderSetting>(fetchImpl, `${baseUrl}/accounts/${accountId}/providers`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * Loads one account's agents.
 * Input: the core base URL, the account id, and fetch.
 * Output: the agents on that account.
 */
async function listAgents(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<RosterAgent[]> {
  return readJson<RosterAgent[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/agents`);
}

/**
 * Hires one agent on the signed-in account.
 * Why: three identity fields (role/personality/job) replace the old blob.
 * Input: the core base URL, the account id, name/role/personality/job, provider/model, fetch.
 * Output: the saved agent. The chat creates its Linux profile later.
 */
async function hireAgent(
  baseUrl: string,
  accountId: string,
  input: { name: string; role?: string; personality?: string; jobDescription?: string; kind?: "work" | "companion"; provider: ProviderSetting["provider"]; modelId: string; look?: AgentMark },
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  const body = agentCreateSchema.parse({
    name: input.name,
    label: input.name,
    // Left out, the agent asks the person what it is for and writes these itself.
    role: input.role ?? "",
    personality: input.personality ?? "",
    jobDescription: input.jobDescription ?? "",
    kind: input.kind ?? "work",
    provider: input.provider,
    modelId: input.modelId,
    ...input.look,
  });
  return readJson<RosterAgent>(fetchImpl, `${baseUrl}/accounts/${accountId}/agents`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Loads the rooms on the signed-in account.
 * Input: the core base URL, the account id, and fetch.
 * Output: the conversations, including each room's title and owner.
 */
async function listConversations(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; kind: string; title: string; ownerAgentId: string; brief?: string | null }[]> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`);
}

/**
 * Loads one room's member agent ids for the group header.
 * Why: a group opens with its title plus member names, never disguised as
 * one owner's 1:1 chat.
 * Input: base URL, account id, conversation id, fetch. Output: member rows.
 */
async function listMembers(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<{ agentId: string }[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/members?accountId=${accountId}`);
}

/**
 * Loads per-chat context + accurate usage for the chat header.
 * Input: base URL, account id, conversation id, fetch. Output: ChatContextInfo.
 */
async function chatContext(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<ChatContextInfo> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/context?accountId=${accountId}`);
}

/**
 * Loads the saved messages for one room with rich payloads.
 * Why: thread renders blocks/images/widgets; body is the text fallback.
 * Input: the core base URL, the account id, the conversation id, and fetch.
 * Output: the messages in time order including kind/payload/replyTo.
 */
async function listMessages(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
  page?: MessagePage,
): Promise<RichMessage[]> {
  const query = new URLSearchParams({ accountId });
  if (page?.limit) query.set("limit", String(page.limit));
  if (page?.before) query.set("before", page.before);
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/messages?${query.toString()}`);
}

/**
 * Fetches one stripped attachment's bytes for lazy image rendering.
 * Why: list responses carry blobRefs instead of megabytes; the thread shows
 * previews instantly and each photo loads once, then caches client-side.
 * Input: base URL, ids, block index, fetch. Output: {url?, previewUrl?}.
 */
async function fetchBlob(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  messageId: string,
  index: number,
  fetchImpl: typeof fetch,
): Promise<{ url?: string; previewUrl?: string; headers?: Record<string, string> }> {
  const found = await readJson<{ url?: string; previewUrl?: string; streamPath?: string }>(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/blob/${messageId}/${index}?accountId=${accountId}`,
  );
  if (!found.streamPath) return found;
  // A large file is streamed from the agent's computer. The player and the
  // downloader make their own requests, so they are handed the session too.
  const cookie = readAuthCookie();
  return {
    url: `${baseUrl}${found.streamPath}?accountId=${accountId}`,
    headers: cookie ? { Cookie: cookie } : undefined,
  };
}

/**
 * Loads tapbacks for one room.
 * Why: reactions render under bubbles without refetching the thread.
 * Input: base URL, account id, conversation id, fetch. Output: reactions.
 */
async function listReactions(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  fetchImpl: typeof fetch,
): Promise<Reaction[]> {
  return readJson(fetchImpl, `${baseUrl}/conversations/${conversationId}/reactions?accountId=${accountId}`);
}

/**
 * Adds one emoji tapback as the human owner.
 * Why: user reactions mirror agent react_to_message; idempotent per emoji.
 * Input: ids + emoji + fetch. Output: saved reaction.
 */
async function react(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  messageId: string,
  emoji: string,
  fetchImpl: typeof fetch,
): Promise<Reaction> {
  return readJson<Reaction>(fetchImpl, `${baseUrl}/conversations/${conversationId}/reactions?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify({ messageId, emoji }),
  });
}

/**
 * Registers an image/file URL for use in a block.
 * Why: rows store URLs not bytes; this validates https/data URIs server-side
 * before the client embeds them. Scoped under the account so the session
 * guard can match it (an account-less route can only 403). S3 presigned
 * upload is the later seam.
 * Input: base URL, account id, url/name/mime, fetch. Output: echoed {url}.
 */
async function upload(
  baseUrl: string,
  accountId: string,
  input: { url: string; name?: string; mime?: string | null },
  fetchImpl: typeof fetch,
): Promise<{ url: string }> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/uploads`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Lists the hiring agent's team (children or shared teamId).
 * Why: phone team sheet needs to pick delegates without full roster dump.
 */
async function listTeam(
  baseUrl: string,
  accountId: string,
  agentId: string,
  fetchImpl: typeof fetch,
): Promise<RosterAgent[]> {
  return readJson(fetchImpl, `${baseUrl}/agents/${agentId}/team?accountId=${accountId}`);
}

/**
 * Hires a child specialist into the same room.
 * Why: lets users build teams from the phone, not just via model tool.
 */
async function hireSubagent(
  baseUrl: string,
  accountId: string,
  parentAgentId: string,
  conversationId: string,
  input: { label: string; role: string; personality?: string; jobDescription: string },
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  return readJson(fetchImpl, `${baseUrl}/agents/${parentAgentId}/subagents?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify({ ...input, conversationId }),
  });
}

/**
 * Opens a direct chat with one agent.
 * Input: the core base URL, the account id, the agent, and fetch.
 * Output: the conversation id.
 */
async function openChat(
  baseUrl: string,
  accountId: string,
  agent: RosterAgent,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  const body = roomCreateSchema.parse({
    kind: "direct",
    title: agent.name,
    ownerAgentId: agent.id,
    memberAgentIds: [agent.id],
  });
  return readJson<{ id: string }>(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Opens a group on the signed-in account.
 * Input: the core base URL, the account id from signup, the title, the member ids, and fetch.
 * Output: the conversation id. The first member owns the room.
 */
async function createGroup(
  baseUrl: string,
  accountId: string,
  title: string,
  agentIds: string[],
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  const ownerAgentId = agentIds[0];
  if (!ownerAgentId) {
    throw new Error("A group needs an agent.");
  }
  const body = roomCreateSchema.parse({
    kind: "group",
    title,
    ownerAgentId,
    memberAgentIds: agentIds,
  });
  return readJson<{ id: string }>(fetchImpl, `${baseUrl}/accounts/${accountId}/conversations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Sends a chat message, including any @mention in the text.
 * Why: the server saves the user row synchronously and returns it, so the
 * phone swaps the optimistic bubble for the confirmed id — the message can
 * never vanish. Default is 202 background + SSE streaming for agent bubbles.
 * Input: base URL, ids, text, optional rich blocks. Output: accepted flag,
 * the saved user message, plus replies only on the sync path (tests).
 */
async function sendMessage(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  body: string,
  rich: { blocks?: MessageBlock[]; replyTo?: string | null } | undefined,
  fetchImpl: typeof fetch,
): Promise<{ accepted: boolean; message: RichMessage; replies?: { id: string; body: string }[] }> {
  // Prefer rich shape whenever blocks or a reply target exist — plain {body}
  // drops replyTo, which left the agent unaware of swipe-replies.
  const payload =
    rich && ((rich.blocks && rich.blocks.length > 0) || rich.replyTo)
      ? {
          blocks: rich.blocks && rich.blocks.length > 0 ? rich.blocks : [{ kind: "text" as const, markdown: body }],
          replyTo: rich.replyTo ?? null,
        }
      : messageCreateSchema.parse({ body });
  const saved = await readJson<{ accepted?: boolean; message: RichMessage; replies?: { id: string; body: string }[] }>(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/messages?accountId=${accountId}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return { accepted: saved.accepted ?? false, message: saved.message, replies: saved.replies };
}

/**
 * Subscribes to live turn events via SSE with cursor resume.
 * Why: progressive multi-bubble turns need push; polling would miss ordering
 * and waste battery. Uses fetch reader so no EventSource polyfill is needed
 * on React Native. Reconnects with backoff resuming from the last cursor, so
 * a dropped connection replays exactly the missed tail (server replays by
 * cursor, client dedups by id). Falls back silently when streaming
 * unsupported (tests).
 * Input: base URL, ids, onEvent, fetch, opts.cursor to resume after.
 * Output: unsubscribe function.
 */
function subscribeMessages(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  onEvent: (event: StreamEvent) => void,
  fetchImpl: typeof fetch,
  opts?: { cursor?: number },
): () => void {
  let cancelled = false;
  let cursor = opts?.cursor ?? 0;
  let attempts = 0;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const pump = async (): Promise<void> => {
    while (!cancelled && attempts < 6) {
      try {
        const cookie = readAuthCookie();
        const response = await fetchImpl(
          `${baseUrl}/conversations/${conversationId}/stream?accountId=${accountId}${cursor > 0 ? `&cursor=${cursor}` : ""}`,
          { credentials: "omit", headers: { ...(cookie ? { cookie } : {}) }, signal: controller?.signal as never },
        );
        if (!response.ok || !response.body) return;
        attempts = 0;
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try {
                const event = JSON.parse(line.slice(6)) as StreamEvent;
                if (typeof event.cursor === "number" && event.cursor > cursor) {
                  cursor = event.cursor;
                }
                onEvent(event);
              } catch {
                // Malformed keepalive; ignore.
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
        if (cancelled) return;
        // Clean EOF (server will normally never end a stream): settle before
        // reconnecting instead of hot-spinning the endpoint.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        // Stream closed mid-flight; back off and resume from the cursor.
      }
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempts, 8000)));
    }
  };
  void pump();
  return () => {
    cancelled = true;
    try {
      controller?.abort();
    } catch {
      // Already closed.
    }
  };
}

/**
 * Registers this phone for push delivery.
 * Why: the relay needs an ExpoPushToken per device; without it the user only
 * gets in-app banners. Idempotent upsert server-side (token rotation safe).
 * Input: base URL, account id, token + platform, fetch. Output: device id.
 */
async function registerDevice(
  baseUrl: string,
  accountId: string,
  input: { expoPushToken: string; platform?: string | null; installId?: string },
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  return readJson(fetchImpl, `${baseUrl}/devices?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Lists pending pings for the badge/inbox fallback.
 * Why: pushes can be missed or dismissed — this is the durable list the phone
 * reconciles on every foreground.
 * Input: base URL, account id, fetch. Output: pending notifications newest-first.
 */
async function ackNotification(
  baseUrl: string,
  accountId: string,
  notificationId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  return readJson(fetchImpl, `${baseUrl}/notifications/${notificationId}/ack?accountId=${accountId}`, { method: "POST" });
}

async function listNotifications(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<PendingNotification[]> {
  return readJson(fetchImpl, `${baseUrl}/notifications?accountId=${accountId}`);
}

/**
 * Loads proposals still waiting on this account.
 * Input: the core base URL, the account id, and fetch.
 * Output: the pending proposals.
 */
async function listProposals(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<Proposal[]> {
  return readJson<Proposal[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/proposals`);
}

/**
 * Approves or rejects one proposal, then reloads the pending list.
 * Input: the core base URL, the account id, the proposal id, the decision, and fetch.
 * Output: the pending proposals after the decision. The decided proposal is omitted.
 */
async function decide(
  baseUrl: string,
  accountId: string,
  proposalId: string,
  action: "approve" | "reject",
  fetchImpl: typeof fetch,
): Promise<Proposal[]> {
  await readJson<unknown>(
    fetchImpl,
    `${baseUrl}/proposals/${proposalId}/${action}?accountId=${accountId}`,
    { method: "POST" },
  );
  return listProposals(baseUrl, accountId, fetchImpl);
}

async function getSettings(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<AccountSettings> {
  return readJson<AccountSettings>(fetchImpl, `${baseUrl}/accounts/${accountId}/settings`);
}

async function setAutoReview(
  baseUrl: string,
  accountId: string,
  autoReview: boolean,
  fetchImpl: typeof fetch,
): Promise<AccountSettings> {
  return readJson<AccountSettings>(fetchImpl, `${baseUrl}/accounts/${accountId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ autoReview }),
  });
}

async function rememberTimezone(
  baseUrl: string,
  accountId: string,
  timezone: string,
  fetchImpl: typeof fetch,
): Promise<AccountSettings> {
  return readJson<AccountSettings>(fetchImpl, `${baseUrl}/accounts/${accountId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ timezone }),
  });
}

async function listToolApprovals(baseUrl: string, accountId: string, fetchImpl: typeof fetch): Promise<ToolApproval[]> {
  return readJson<ToolApproval[]>(fetchImpl, `${baseUrl}/accounts/${accountId}/tool-approvals`);
}

async function decideTool(
  baseUrl: string,
  accountId: string,
  approvalId: string,
  action: "approve" | "approve?always=1" | "deny",
  fetchImpl: typeof fetch,
): Promise<ToolApproval[]> {
  await readJson<unknown>(
    fetchImpl,
    `${baseUrl}/accounts/${accountId}/tool-approvals/${approvalId}/${action}`,
    { method: "POST" },
  );
  return listToolApprovals(baseUrl, accountId, fetchImpl);
}

/**
 * Saves the agent's profile on the core.
 * Input: the core base URL, the account id, the agent id, the profile fields, and fetch.
 * Output: the saved agent. The phone does not write prompt files.
 */
async function saveProfile(
  baseUrl: string,
  accountId: string,
  agentId: string,
  profile: AgentProfile,
  fetchImpl: typeof fetch,
): Promise<RosterAgent> {
  const body = agentProfileSchema.parse(profile);
  return readJson<RosterAgent>(fetchImpl, `${baseUrl}/agents/${agentId}?accountId=${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Lists one agent's routines, soonest first.
 * Input: the core base URL, account + agent ids, and fetch.
 * Output: the agent's routines.
 */
async function listRoutines(
  baseUrl: string,
  accountId: string,
  agentId: string,
  fetchImpl: typeof fetch,
): Promise<Routine[]> {
  return readJson<Routine[]>(fetchImpl, `${baseUrl}/agents/${agentId}/routines?accountId=${accountId}`);
}

/**
 * Loads up to 10 finished fires for one routine (newest first).
 * Why: the detail page shows Completed/Failed history beyond the one-line last run.
 */
async function listRoutineRuns(
  baseUrl: string,
  accountId: string,
  agentId: string,
  routineId: string,
  fetchImpl: typeof fetch,
): Promise<RoutineRun[]> {
  return readJson<RoutineRun[]>(
    fetchImpl,
    `${baseUrl}/agents/${agentId}/routines/${routineId}/runs?accountId=${accountId}`,
  );
}

/**
 * Creates one routine owned by the agent.
 * Input: the core base URL, account + agent ids, the room + body + cron, and fetch.
 * Output: the saved routine.
 */
async function createRoutine(
  baseUrl: string,
  accountId: string,
  agentId: string,
  input: RoutineInput,
  fetchImpl: typeof fetch,
): Promise<Routine> {
  return readJson<Routine>(fetchImpl, `${baseUrl}/agents/${agentId}/routines?accountId=${accountId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Changes one routine's title, instructions, schedule, or paused flag.
 * Input: the core base URL, ids, the patch fields, and fetch.
 * Output: the updated routine.
 */
async function updateRoutine(
  baseUrl: string,
  accountId: string,
  agentId: string,
  routineId: string,
  input: RoutinePatch,
  fetchImpl: typeof fetch,
): Promise<Routine> {
  return readJson<Routine>(fetchImpl, `${baseUrl}/agents/${agentId}/routines/${routineId}?accountId=${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * Deletes one routine and its pending jobs.
 * Input: the core base URL, ids, and fetch. Output: nothing.
 */
async function deleteRoutine(
  baseUrl: string,
  accountId: string,
  agentId: string,
  routineId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cookie = readAuthCookie();
  const response = await fetchImpl(`${baseUrl}/agents/${agentId}/routines/${routineId}?accountId=${accountId}`, {
    method: "DELETE",
    credentials: "omit",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `Core returned ${response.status}.`);
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Words one cron schedule the way the bot info page shows it.
 * Why: "32 9 * * 1-5" means nothing to a person; "Weekdays at 9:32 AM" does.
 * Input: the cron text. Output: "Every day at 10:11 AM", "Weekdays at 9:32 AM",
 * "Every Monday at 4:14 PM", "Every 15 minutes", or the raw cron when unknown.
 */
export function formatSchedule(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return cron;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const interval = /^\*\/(\d+)$/.exec(minute);
  if (interval && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const step = Number(interval[1]);
    return step === 1 ? "Every minute" : `Every ${step} minutes`;
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dayOfMonth !== "*" || month !== "*") {
    return cron;
  }
  const minuteNum = Number(minute);
  const hourNum = Number(hour);
  if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) {
    return cron;
  }
  const time = formatWallTime(hourNum, minuteNum);
  if (dayOfWeek === "*") {
    return `Every day at ${time}`;
  }
  const days = parseCronWeekdays(dayOfWeek);
  if (!days) {
    return cron;
  }
  if (days.size === 5 && days.has(1) && days.has(2) && days.has(3) && days.has(4) && days.has(5)) {
    return `Weekdays at ${time}`;
  }
  if (days.size === 1) {
    const [day] = [...days];
    return `Every ${WEEKDAY_NAMES[day ?? 0]} at ${time}`;
  }
  return cron;
}

/** Words one wall time. Input: 24-hour hour + minute. Output: "9:32 AM". */
function formatWallTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * Parses a cron weekday field. Input: "1", "1-5", "1,3,5".
 * Output: the weekday set (0=Sunday..6=Saturday), or null when unknown.
 */
function parseCronWeekdays(raw: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of raw.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || start < 0 || end > 7) {
        return null;
      }
      for (let day = start; day <= end; day += 1) {
        days.add(day === 7 ? 0 : day);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const day = Number(part);
    if (day < 0 || day > 7) {
      return null;
    }
    days.add(day === 7 ? 0 : day);
  }
  return days.size > 0 ? days : null;
}

/**
 * Builds a cron from the routine composer's schedule picks.
 * Input: "daily" or "weekdays" or one weekday index, plus wall hour/minute.
 * Output: the cron text the core scheduler accepts.
 */
export function buildCron(kind: "daily" | "weekdays" | number, hour: number, minute: number): string {
  if (kind === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (kind === "weekdays") {
    return `${minute} ${hour} * * 1-5`;
  }
  return `${minute} ${hour} * * ${kind}`;
}

/**
 * The routine title shown in the list / detail header.
 * Why: prefers the stored title; falls back to the first instructions line.
 */
export function routineTitle(routine: { title?: string | null; instructions?: string | null } | string): string {
  if (typeof routine === "string") {
    const first = routine.split("\n")[0]?.trim() ?? "";
    return first.length > 80 ? `${first.slice(0, 80)}…` : first || "Untitled routine";
  }
  const titled = routine.title?.trim();
  if (titled) return titled.length > 80 ? `${titled.slice(0, 80)}…` : titled;
  const first = routine.instructions?.split("\n")[0]?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 80)}…` : first || "Untitled routine";
}

/**
 * Relative run-history label matching the phone detail screen.
 * Why: "Yesterday at 16:21" / "Last Thursday at 16:22" / "Sep 26 at 16:21".
 */
export function formatRunHistoryWhen(iso: string, timeZone: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    const zone = timeZone || "UTC";
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zone,
    }).format(date);
    const dayKey = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(value);
    const todayKey = dayKey(now);
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayKey = dayKey(yesterday);
    const runKey = dayKey(date);
    if (runKey === todayKey) return `today at ${time}`;
    if (runKey === yesterdayKey) return `Yesterday at ${time}`;
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: zone }).format(date);
    const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
    if (daysAgo > 1 && daysAgo < 7) return `Last ${weekday} at ${time}`;
    const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone }).format(date);
    return `${monthDay} at ${time}`;
  } catch {
    return "—";
  }
}

/**
 * Next-run label for the schedule card ("today at 16:14").
 */
export function formatNextRunRelative(iso: string, timeZone: string, now = new Date()): string {
  return formatRunHistoryWhen(iso, timeZone, now);
}

/**
 * Short last-run line for the routines list/detail.
 * Why: people need to see whether the last fire completed or failed.
 * Input: lastRunAt ISO + status. Output: "Never run" or "Completed · …" / "Failed · …".
 */
export function formatLastRun(
  lastRunAt: string | null | undefined,
  lastRunStatus: "done" | "failed" | null | undefined,
  timeZone: string,
): string {
  if (!lastRunAt || !lastRunStatus) return "Never run";
  const label = lastRunStatus === "failed" ? "Failed" : "Completed";
  const date = new Date(lastRunAt);
  if (Number.isNaN(date.getTime())) return label;
  try {
    const when = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone || "UTC",
    }).format(date);
    return `${label} · ${when}`;
  } catch {
    return label;
  }
}

/**
 * Saves one vault secret for the account. Write-only: the name echoes back,
 * the value never does, and it never appears in chat.
 * Input: the core base URL, account id, env name + secret, fetch.
 * Output: the name and configured flag.
 */
async function saveSecret(
  baseUrl: string,
  accountId: string,
  input: { name: string; secret: string },
  fetchImpl: typeof fetch,
): Promise<{ name: string; configured: boolean }> {
  return readJson<{ name: string; configured: boolean }>(fetchImpl, `${baseUrl}/accounts/${accountId}/secrets`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Wakes the room agent with a hidden cue (no user chat bubble).
 * Why: question taps and secret saves must continue the turn without looking
 * like the person typed the option into chat.
 */
async function wakeCue(
  baseUrl: string,
  accountId: string,
  conversationId: string,
  input: { cue: string; messageId?: string; selected?: string },
  fetchImpl: typeof fetch,
): Promise<{ accepted: boolean }> {
  return readJson<{ accepted: boolean }>(
    fetchImpl,
    `${baseUrl}/conversations/${conversationId}/cues?accountId=${accountId}`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/**
 * Builds the websocket URL for one profile's desktop.
 * Input: the core base URL, the account id, and the Linux username.
 * Output: a core websocket URL. It uses the core host, not a container port.
 */
export function screenUrl(baseUrl: string, accountId: string, profile: string, token?: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/accounts/${accountId}/screens/${encodeURIComponent(profile)}`;
  url.search = "";
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function getScreenToken(
  baseUrl: string,
  accountId: string,
  profile: string,
  fetchImpl: typeof fetch,
): Promise<{ token: string }> {
  return readJson(fetchImpl, `${baseUrl}/accounts/${accountId}/screens/${encodeURIComponent(profile)}/ws-token`);
}

/**
 * Builds the URL of the noVNC viewer page for one profile.
 * Input: the core base URL, the account id, and the Linux username.
 * Output: a core http(s) URL. The page and the socket it opens share an origin
 * so the session cookie the phone holds reaches the core's screen proxy.
 */
export function screenPageUrl(baseUrl: string, accountId: string, profile: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.pathname = `/accounts/${accountId}/screens/${encodeURIComponent(profile)}/client`;
  url.search = "";
  return url.toString();
}

/**
 * Takes the pointer or hands it back.
 * Input: the core base URL, the account id, the Linux username, the action, and fetch.
 * Output: nothing. The core pauses or resumes the agent's mouse and keyboard.
 */
async function screenFlag(
  baseUrl: string,
  accountId: string,
  profile: string,
  action: "takeover" | "handback",
  fetchImpl: typeof fetch,
): Promise<void> {
  await readJson<unknown>(
    fetchImpl,
    `${baseUrl}/accounts/${accountId}/screens/${encodeURIComponent(profile)}/${action}`,
    { method: "POST" },
  );
}

/**
 * Inserts an @mention into the composer.
 * Input: the current draft and the agent name.
 * Output: the draft with `@name` at the end when that mention is not already present.
 */
export function mention(draft: string, name: string): string {
  const token = `@${name}`;
  if (draft.includes(token)) {
    return draft;
  }
  const gap = draft.length === 0 || draft.endsWith(" ") ? "" : " ";
  return `${draft}${gap}${token} `;
}

async function readJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const cookie = readAuthCookie();
  const response = await fetchImpl(url, {
    ...init,
    // The session travels in the header below and nowhere else. Without this
    // the phone also sends whatever sign-in its own cookie store last saw,
    // which wins over the header: with two accounts signed in, requests for
    // one went out as the other and the server rightly refused them.
    credentials: "omit",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `Core returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}
