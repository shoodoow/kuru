import {
  accountSchema,
  agentCreateSchema,
  agentProfileSchema,
  defaultModelSchema,
  randomSurpriseMark,
} from "@kuru/shared";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { getDb, Store } from "../db/client.js";
import { accounts, agents, conversations, members } from "../db/schema.js";
import { ProviderCheckError, unknownModel, type ProviderCheck } from "../keys/check-provider.js";
import { keyFor, listProviderKeys } from "../keys/keys.js";
import { createLinux } from "../linux/linux.js";
import { noted } from "../log/logger.js";
import { resolveGatewayContextWindow } from "../model/gateway-models.js";
import { prompt } from "../prompt/prompts.js";
import type { GenerateResult, TurnInput } from "../turn/types.js";

/**
 * The default agent's name on a new account. The only place it is written:
 * prompts use the agent's current name, and the person can rename it.
 */
export const DEFAULT_SUPPORT_NAME = "Chief of Staff";

/** The role shown for an agent that has not written its own yet. */
export const UNSET_ROLE = "New agent";

type Database = ReturnType<typeof getDb>;

/**
 * True for an agent created with only a name, until it writes its own profile.
 * Its job description is the standing note that tells it to find out what it is for.
 */
export function isUnsetAgent(agent: { jobDescription: string }): boolean {
  return agent.jobDescription === prompt("dispatcher", "new-agent-job");
}

/** The default agent's role, job and kind are set by the core and cannot be edited. */
export class ProtectedAgentError extends Error {
  constructor(message = "This agent's role and job are fixed. Its name, look and model can be changed.") {
    super(message);
    this.name = "ProtectedAgentError";
  }
}

/** A default model was chosen for a provider the account holds no key for. */
export class MissingProviderKeyError extends Error {
  constructor(provider: string) {
    super(`Add a key for ${provider} before choosing it as the default.`);
    this.name = "MissingProviderKeyError";
  }
}

export class AgentNameError extends Error {
  constructor() {
    super("An agent with this name already exists on this account");
    this.name = "AgentNameError";
  }
}

/**
 * Creates an account row and that account's Linux.
 * Why: the account is the tenant — one Linux per account, every later row
 * carries this id so nothing crosses accounts.
 * Input: a database client and an object with a name.
 * Output: the saved account, including its id. A container exists for that id.
 */
export async function createAccount(db: Database, input: unknown, options?: { email?: string }) {
  const data = accountSchema.parse(input);
  const [row] = await db.insert(accounts).values({ name: data.name }).returning();
  if (!row) {
    throw new Error("The account insert returned no row.");
  }
  try {
    await createLinux(row.id, options?.email);
  } catch (error) {
    await db.delete(accounts).where(eq(accounts.id, row.id));
    throw error;
  }
  return row;
}

/**
 * Hires an agent inside one account.
 * Why: names are unique per account (case-insensitive) because @Name routing
 * and the room header resolve by exact name — duplicates silently steal each
 * other's mentions. Same name on another account is fine.
 * Input: a database client, the account id, and name/label/role/personality/
 * jobDescription/provider/modelId.
 * Output: the saved agent. linuxProfile is null because the chat creates the profile later.
 */
export async function createAgent(db: Database, accountId: string, input: unknown) {
  const data = agentCreateSchema.parse(input);
  const siblings = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.accountId, accountId));
  if (siblings.some((sibling) => sibling.name.toLowerCase() === data.name.toLowerCase())) {
    throw new AgentNameError();
  }
  const surprise = randomSurpriseMark();
  const modelContextWindow = await resolveGatewayContextWindow(data.provider, data.modelId);
  const [row] = await db
    .insert(agents)
    .values({
      accountId,
      name: data.name,
      label: data.label,
      role: data.role || UNSET_ROLE,
      personality: data.personality ?? "",
      // No job given: the agent asks the person what it is for, then writes its own.
      jobDescription: data.jobDescription || prompt("dispatcher", "new-agent-job"),
      kind: data.kind,
      provider: data.provider,
      modelId: data.modelId,
      modelContextWindow,
      linuxProfile: null,
      markShape: data.markShape ?? surprise.markShape,
      markColor: data.markColor ?? surprise.markColor,
      markMaterial: data.markMaterial ?? surprise.markMaterial,
      markStyle: data.markStyle ?? surprise.markStyle,
      markGender: data.markGender ?? surprise.markGender,
    })
    .returning();
  if (!row) {
    throw new Error("The agent insert returned no row.");
  }
  return row;
}

/**
 * Changes an agent's name, label, identity, model provider, pin, hide, and notify.
 * Why: identity edits (the kind included, since it picks the standing prompt)
 * bump promptVersion so the OpenAI promptCacheKey rotates — otherwise the
 * provider keeps serving the stale cached prefix.
 * Input: a database client, the owning account id, the agent id, and profile fields.
 * Output: the updated agent, or null when that account does not own the agent.
 */
export async function updateAgentFlags(db: Store, accountId: string, agentId: string, input: unknown) {
  const data = agentProfileSchema.parse(input);
  const identityTouched =
    data.name !== undefined ||
    data.label !== undefined ||
    data.role !== undefined ||
    data.personality !== undefined ||
    data.jobDescription !== undefined ||
    data.kind !== undefined;
  if (
    data.role !== undefined ||
    data.jobDescription !== undefined ||
    data.kind !== undefined ||
    data.name !== undefined ||
    data.label !== undefined ||
    data.pinned !== undefined ||
    data.hidden !== undefined
  ) {
    // The app saves the whole profile at once, so only a real change is refused.
    // The Chief of Staff keeps its name and title, and stays pinned and visible.
    const current = await getAgent(db, accountId, agentId);
    const changed =
      (data.role !== undefined && data.role !== current?.role) ||
      (data.jobDescription !== undefined && data.jobDescription !== current?.jobDescription) ||
      (data.kind !== undefined && data.kind !== current?.kind) ||
      (data.name !== undefined && data.name !== current?.name) ||
      (data.label !== undefined && data.label !== current?.label) ||
      (data.pinned === false) ||
      (data.hidden === true);
    if (current?.kind === "support" && changed) throw new ProtectedAgentError();
    if (current && current.kind !== "support" && data.kind === "support") {
      throw new ProtectedAgentError("An account has one default agent, and it is created for you.");
    }
  }
  let modelContextWindow: number | null | undefined;
  if (data.provider !== undefined || data.modelId !== undefined) {
    const current = await getAgent(db, accountId, agentId);
    if (current) {
      modelContextWindow = await resolveGatewayContextWindow(
        data.provider ?? current.provider,
        data.modelId ?? current.modelId,
      );
    }
  }
  const [row] = await db
    .update(agents)
    .set({
      ...(data.notify !== undefined ? { notify: data.notify } : {}),
      ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
      ...(data.hidden !== undefined ? { hidden: data.hidden } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.personality !== undefined ? { personality: data.personality } : {}),
      ...(data.jobDescription !== undefined ? { jobDescription: data.jobDescription } : {}),
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
      ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
      ...(data.markShape !== undefined ? { markShape: data.markShape } : {}),
      ...(data.markColor !== undefined ? { markColor: data.markColor } : {}),
      ...(data.markMaterial !== undefined ? { markMaterial: data.markMaterial } : {}),
      ...(data.markStyle !== undefined ? { markStyle: data.markStyle } : {}),
      ...(data.markGender !== undefined ? { markGender: data.markGender } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
      ...(identityTouched ? { promptVersion: sql`${agents.promptVersion} + 1` } : {}),
    })
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .returning();
  return row ?? null;
}

/**
 * Lists the agents on one account.
 * Why: roster and team pickers scope to the tenant — cross-account rows never leave the query.
 * Input: a database client and the account id.
 * Output: that account's agents. Another account's agents are not included.
 */
export async function listAgents(db: Database, accountId: string) {
  return db.select().from(agents).where(eq(agents.accountId, accountId));
}

/**
 * Reads one agent that belongs to an account.
 * Why: per-request ownership re-check — ids are never trusted from the client.
 * Input: a database client, the account id, and the agent id.
 * Output: the agent row, or null when the account does not own it.
 */
export async function getAgent(db: Store, accountId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

/** The model the person chose for this account, or null before setup is finished. */
export async function defaultModelFor(db: Database, accountId: string): Promise<{ provider: string; modelId: string } | null> {
  const [row] = await db
    .select({ provider: accounts.defaultProvider, modelId: accounts.defaultModelId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.provider && row.modelId ? { provider: row.provider, modelId: row.modelId } : null;
}

/**
 * Saves the account's default model.
 * Why: a model id cannot be guessed, and a provider with no key fails every
 * turn, so the person names both once, right after adding a key.
 * Input: db, account id, provider and model id. Output: what was saved.
 * Throws when the account holds no key for that provider.
 */
export async function setDefaultModel(
  db: Database,
  accountId: string,
  input: unknown,
  /** Asks the provider for its models, so a mistyped model id is caught now. Left out, the id is taken as typed. */
  check?: (provider: string, apiKey: string, baseUrl: string | null) => Promise<ProviderCheck>,
  /**
   * Sends the model one tiny request and returns what went wrong, or null.
   * Used only for an id the provider does not list: providers accept spellings
   * they do not list, and the only sure test of one is to use it.
   */
  tryModel?: (provider: string, modelId: string, apiKey: string, baseUrl: string | null) => Promise<string | null>,
) {
  const data = await checkedModelChoice(db, accountId, input, check, tryModel);
  await db
    .update(accounts)
    .set({ defaultProvider: data.provider, defaultModelId: data.modelId })
    .where(eq(accounts.id, accountId));
  return data;
}

/**
 * Validates a provider and model the person typed.
 * Input: db, account id, the raw choice, and the optional provider checks.
 * Output: the parsed choice. Throws when there is no key, or the provider rejects the id.
 */
async function checkedModelChoice(
  db: Database,
  accountId: string,
  input: unknown,
  check?: (provider: string, apiKey: string, baseUrl: string | null) => Promise<ProviderCheck>,
  tryModel?: (provider: string, modelId: string, apiKey: string, baseUrl: string | null) => Promise<string | null>,
) {
  const data = defaultModelSchema.parse(input);
  const keys = await listProviderKeys(db, accountId);
  if (!keys.some((key) => key.provider === data.provider && key.configured)) {
    throw new MissingProviderKeyError(data.provider);
  }
  if (check) {
    const key = await keyFor(db, accountId, data.provider);
    const checked = await check(data.provider, key.apiKey, key.baseUrl);
    if (checked.ok === false) throw new ProviderCheckError(checked.error);
    const unknown = checked.ok ? unknownModel(data.modelId, checked.models) : null;
    if (unknown) {
      const failure = tryModel ? await tryModel(data.provider, data.modelId, key.apiKey, key.baseUrl) : "not tried";
      if (failure !== null) throw new ProviderCheckError(unknown);
    }
  }
  return data;
}

/** The cheaper model for background work, or null when the person has not set one. */
export async function cheapModelFor(db: Database, accountId: string): Promise<{ provider: string; modelId: string } | null> {
  const [row] = await db
    .select({ provider: accounts.cheapProvider, modelId: accounts.cheapModelId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.provider && row.modelId ? { provider: row.provider, modelId: row.modelId } : null;
}

/**
 * Saves or clears the account's cheap model.
 * Why: background workers spend almost all of an account's tokens (51 of 53
 * million in one day for one agent), on long tool loops that a cheaper model
 * handles well. Chat agents, where judgment matters, keep their own model.
 * Input: db, account id, and a provider/model choice, or null to clear it.
 * Output: what was saved, or null when cleared.
 */
export async function setCheapModel(
  db: Database,
  accountId: string,
  input: unknown,
  check?: (provider: string, apiKey: string, baseUrl: string | null) => Promise<ProviderCheck>,
  tryModel?: (provider: string, modelId: string, apiKey: string, baseUrl: string | null) => Promise<string | null>,
) {
  if (input === null || (typeof input === "object" && input !== null && !(input as { modelId?: unknown }).modelId)) {
    await db.update(accounts).set({ cheapProvider: null, cheapModelId: null }).where(eq(accounts.id, accountId));
    return null;
  }
  const data = await checkedModelChoice(db, accountId, input, check, tryModel);
  await db
    .update(accounts)
    .set({ cheapProvider: data.provider, cheapModelId: data.modelId })
    .where(eq(accounts.id, accountId));
  return data;
}

/**
 * Picks the model the default agent runs on.
 * Order: the operator's override, the model the person chose, then (for an
 * account older than that setting) its newest agent's model.
 * Input: db and account id. Output: provider and model id, or null until the person has chosen one.
 */
async function supportModel(db: Database, accountId: string): Promise<{ provider: string; modelId: string } | null> {
  const fixed = config.supportModel();
  if (fixed) return fixed;
  const chosen = await defaultModelFor(db, accountId);
  if (chosen) return chosen;
  const [newest] = await db
    .select({ provider: agents.provider, modelId: agents.modelId })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), ne(agents.kind, "support")))
    .orderBy(desc(agents.createdAt))
    .limit(1);
  return newest ?? null;
}

/**
 * Makes sure the account has its default (support) agent and its chat.
 * Why: a new person should meet an agent that asks about them and sets the
 * others up, instead of an empty form asking for a job description.
 * Safe to call on every sign-in: it does nothing once the agent exists, and
 * waits (returns null) while the account has no usable model yet.
 * Input: db, account id, and an optional callback run once when the agent is
 * newly created (used to have it write its first message).
 * Output: the support agent, or null when it cannot be created yet.
 */
export async function ensureSupportAgent(
  db: Database,
  accountId: string,
  options?: { onCreated?: (created: { agentId: string; conversationId: string }) => void },
) {
  const find = async () => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.accountId, accountId), eq(agents.kind, "support")))
      .limit(1);
    return row ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const model = await supportModel(db, accountId);
  if (!model) return null;
  const taken = new Set(
    (await db.select({ name: agents.name }).from(agents).where(eq(agents.accountId, accountId))).map((row) =>
      row.name.toLowerCase(),
    ),
  );
  let name = DEFAULT_SUPPORT_NAME;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${DEFAULT_SUPPORT_NAME} ${n}`;
  const surprise = randomSurpriseMark();
  const modelContextWindow = await resolveGatewayContextWindow(model.provider, model.modelId).catch(() => null);
  try {
    const created = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          accountId,
          name,
          label: name,
          role: prompt("support", "role"),
          personality: prompt("support", "personality"),
          jobDescription: prompt("support", "job"),
          kind: "support",
          provider: model.provider,
          modelId: model.modelId,
          modelContextWindow,
          linuxProfile: null,
          pinned: true,
          markShape: surprise.markShape,
          markColor: surprise.markColor,
          markMaterial: surprise.markMaterial,
          markStyle: surprise.markStyle,
          markGender: surprise.markGender,
        })
        .returning();
      if (!agent) throw new Error("The support agent insert returned no row.");
      const [room] = await tx
        .insert(conversations)
        .values({ accountId, kind: "direct", ownerAgentId: agent.id, title: name })
        .returning();
      if (!room) throw new Error("The support room insert returned no row.");
      await tx.insert(members).values({ conversationId: room.id, accountId, agentId: agent.id });
      return { agent, conversationId: room.id };
    });
    options?.onCreated?.({ agentId: created.agent.id, conversationId: created.conversationId });
    return created.agent;
  } catch (error) {
    // Two sign-ins at once: the unique index lets one through; the other reads its row.
    const raced = await find();
    if (raced) return raced;
    throw error;
  }
}

/**
 * `ensureSupportAgent` for the HTTP routes: never fails the request, and has a
 * newly created agent open its chat itself.
 * Why: the first message is written by the model, so it can greet the person
 * by name, in their language, with a tappable first question.
 * Input: db, account id, and the test stub for the model when there is one.
 */
export async function ensureSupportAgentQuietly(
  db: Database,
  accountId: string,
  generate?: (input: TurnInput) => Promise<GenerateResult>,
): Promise<void> {
  await ensureSupportAgent(db, accountId, {
    onCreated: ({ agentId, conversationId }) => {
      void import("../turn/first-hello.js").then(({ startFirstHello }) =>
        startFirstHello(db, { accountId, conversationId, agentId, kind: "support", generate, skillsRoot: config.skillsDir() }),
      );
    },
  }).catch(noted("Creating the default agent"));
}
