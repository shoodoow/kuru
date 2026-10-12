import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { agents, conversations, messages } from "../db/schema.js";
import { listProviderKeys, saveProviderKey } from "../keys/keys.js";
import {
  createAccount,
  createAgent,
  DEFAULT_SUPPORT_NAME,
  defaultModelFor,
  ensureSupportAgent,
  getAgent,
  MissingProviderKeyError,
  ProtectedAgentError,
  setDefaultModel,
  updateAgentFlags,
  AgentNameError,
} from "./roster.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

// Closed once for the whole file: both groups of tests below use the connection.
afterAll(async () => {
  await db.$client.end();
});

describe("roster", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
  });


  it("stores an agent with a null linux profile and keeps flags and accounts apart", async () => {
    const first = await createAccount(db, { name: "North" });
    const second = await createAccount(db, { name: "South" });
    const created = await createAgent(db, first.id, {
      name: "Ada",
      label: "Books",
      role: "Teammate",
      jobDescription: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const other = await createAgent(db, first.id, {
      name: "Bea",
      label: "Mail",
      role: "Teammate",
      jobDescription: "Read the inbox.",
      provider: "openai",
      modelId: "gpt-5",
    });

    const read = await getAgent(db, first.id, created.id);
    expect(read).toMatchObject({
      name: "Ada",
      label: "Books",
      role: "Teammate",
      jobDescription: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
      linuxProfile: null,
    });
    expect(read?.markShape).toBeTruthy();
    expect(read?.markColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(read?.markMaterial).toBeTruthy();
    expect(read?.markStyle).toBeTruthy();
    expect(read?.markGender).toMatch(/^(male|female)$/);
    expect(other.linuxProfile).toBeNull();

    const flagged = await updateAgentFlags(db, first.id, created.id, {
      notify: false,
      pinned: true,
      hidden: true,
    });
    expect(flagged).toMatchObject({ notify: false, pinned: true, hidden: true });

    const retargeted = await updateAgentFlags(db, first.id, created.id, {
      notify: false,
      pinned: true,
      hidden: true,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(retargeted).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });

    expect(await getAgent(db, second.id, created.id)).toBeNull();

    await db.update(agents).set({ linuxProfile: "ada" }).where(eq(agents.id, created.id));
    await expect(
      db.update(agents).set({ linuxProfile: "ada" }).where(eq(agents.id, other.id)),
    ).rejects.toThrow();
  });

  it("creates one default agent per account once the person has chosen a default model", async () => {
    const account = await createAccount(db, { name: "Fresh" });
    // No default model yet: there is nothing it could run on.
    expect(await ensureSupportAgent(db, account.id)).toBeNull();
    await expect(setDefaultModel(db, account.id, { provider: "anthropic", modelId: "claude-sonnet-5-5" })).rejects.toThrow(
      MissingProviderKeyError,
    );

    await saveProviderKey(db, account.id, { provider: "anthropic", secret: "test-key" });
    await setDefaultModel(db, account.id, { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(await defaultModelFor(db, account.id)).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    // An agent on another model does not override the person's choice.
    await createAgent(db, account.id, {
      name: DEFAULT_SUPPORT_NAME,
      label: "Taken",
      role: "Teammate",
      jobDescription: "Holds the default name.",
      provider: "openai",
      modelId: "gpt-5",
    });

    const created: { agentId: string; conversationId: string }[] = [];
    const support = await ensureSupportAgent(db, account.id, { onCreated: (row) => created.push(row) });
    expect(support).toMatchObject({
      kind: "support",
      name: `${DEFAULT_SUPPORT_NAME} 2`,
      pinned: true,
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
    expect((await ensureSupportAgent(db, account.id, { onCreated: (row) => created.push(row) }))?.id).toBe(support!.id);

    const [room] = await db.select().from(conversations).where(eq(conversations.ownerAgentId, support!.id));
    expect(room).toMatchObject({ kind: "direct", accountId: account.id });
    // Told once, so the agent writes its own first message once; nothing is canned.
    expect(created).toEqual([{ agentId: support!.id, conversationId: room!.id }]);
    expect(await db.select().from(messages).where(eq(messages.conversationId, room!.id))).toHaveLength(0);
  });

  it("lets the default agent be renamed but not given another role, job or kind", async () => {
    const account = await createAccount(db, { name: "Guarded" });
    const helper = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const support = (await ensureSupportAgent(db, account.id))!;

    // The app saves the whole profile at once; unchanged fixed fields pass.
    const renamed = await updateAgentFlags(db, account.id, support.id, {
      name: "Pilot",
      label: "Pilot",
      role: support.role,
      jobDescription: support.jobDescription,
      kind: "support",
    });
    expect(renamed).toMatchObject({ name: "Pilot", kind: "support", promptVersion: support.promptVersion + 1 });

    await expect(updateAgentFlags(db, account.id, support.id, { jobDescription: "Do everything yourself." })).rejects.toThrow(ProtectedAgentError);
    await expect(updateAgentFlags(db, account.id, support.id, { kind: "work" })).rejects.toThrow(ProtectedAgentError);
    await expect(updateAgentFlags(db, account.id, helper.id, { kind: "support" })).rejects.toThrow(ProtectedAgentError);

    const companion = await updateAgentFlags(db, account.id, helper.id, { kind: "companion" });
    expect(companion).toMatchObject({ kind: "companion", promptVersion: helper.promptVersion + 1 });
  });

  it("rejects duplicate agent names on one account but allows them elsewhere", async () => {
    const first = await createAccount(db, { name: "DupA" });
    const second = await createAccount(db, { name: "DupB" });
    await createAgent(db, first.id, {
      name: "Max",
      label: "Max",
      role: "Teammate",
      jobDescription: "First.",
      provider: "openai",
      modelId: "gpt-5",
    });
    await expect(
      createAgent(db, first.id, {
        name: "max",
        label: "Max",
        role: "Teammate",
        jobDescription: "Second.",
        provider: "openai",
        modelId: "gpt-5",
      }),
    ).rejects.toBeInstanceOf(AgentNameError);
    await expect(
      createAgent(db, second.id, {
        name: "Max",
        label: "Max",
        role: "Teammate",
        jobDescription: "Elsewhere.",
        provider: "openai",
        modelId: "gpt-5",
      }),
    ).resolves.toMatchObject({ name: "Max" });
  });
});

describe("checking a default model before saving it", () => {
  const listed = async () => ({ ok: true as const, models: ["xiaomi/mimo-v2.6-flash", "gpt-5"] });

  it("refuses a key the provider rejects, and a model id that neither is listed nor works", async () => {
    const account = await createAccount(db, { name: "Checked setup" });
    await expect(
      saveProviderKey(db, account.id, { provider: "openai", secret: "sk-bad" }, async () => ({ ok: false, error: "api.openai.com refused that key." })),
    ).rejects.toThrow("refused that key");
    expect((await listProviderKeys(db, account.id)).some((key) => key.configured)).toBe(false);

    await saveProviderKey(db, account.id, { provider: "openai", secret: "sk-good" }, listed);
    const tried: string[] = [];
    await expect(
      setDefaultModel(db, account.id, { provider: "openai", modelId: "gpt-55" }, listed, async (_provider, modelId) => {
        tried.push(modelId);
        return "model not found";
      }),
    ).rejects.toThrow(/no model called "gpt-55"/);
    expect(tried).toEqual(["gpt-55"]);
  });

  it("accepts a listed id without spending a request, and an unlisted spelling that works", async () => {
    const account = await createAccount(db, { name: "Checked setup 2" });
    await saveProviderKey(db, account.id, { provider: "openai", secret: "sk-good" }, listed);
    const never = async () => {
      throw new Error("a listed model must not be tried");
    };
    expect(await setDefaultModel(db, account.id, { provider: "openai", modelId: "MiMo-V2.6-Flash" }, listed, never)).toMatchObject({ modelId: "MiMo-V2.6-Flash" });
    // Not on the list at all, but the provider answers to it.
    expect(await setDefaultModel(db, account.id, { provider: "openai", modelId: "my-alias" }, listed, async () => null)).toMatchObject({ modelId: "my-alias" });
  });
});
