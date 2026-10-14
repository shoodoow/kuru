import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../db/client.js";
import { agents, conversations, memories, messages } from "../../db/schema.js";
import { briefFor } from "../../memory/memory.js";
import { createAccount, createAgent, ensureSupportAgent, isUnsetAgent, UNSET_ROLE } from "../../roster/roster.js";
import type { ToolContext } from "./context.js";
import { dispatcherExecutors } from "./executors.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

type Result = Record<string, unknown>;

/** An account with one work agent, its default agent, and a message from the person in the default agent's chat. */
async function setUp(name: string) {
  const account = await createAccount(db, { name });
  const worker = await createAgent(db, account.id, {
    name: "Mina",
    label: "Mina",
    role: "Social media manager",
    jobDescription: "Plan and write the weekly posts.",
    provider: "openai",
    modelId: "gpt-5",
  });
  const support = (await ensureSupportAgent(db, account.id))!;
  const [room] = await db.select().from(conversations).where(eq(conversations.ownerAgentId, support.id));
  await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, body: "Mina keeps writing for the wrong audience." });
  const ctxFor = (agentId: string): ToolContext => {
    let tick = Date.now();
    return {
      db,
      store: db,
      accountId: account.id,
      conversationId: room!.id,
      agentId,
      runId: randomUUID(),
      nextTime: () => new Date((tick += 1)),
      emittedMessages: [],
      emit: async () => {
        // Nobody is listening to the stream in a test.
      },
      // Stands in for the model when a hired agent writes its first message.
      generate: async () => "Hi, I'm here and ready when you are.",
    };
  };
  return { account, worker, support, ctxFor };
}

/** Polls until `read` returns a value, for work that finishes in the background. */
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const call = (name: string, ctx: ToolContext, input: Record<string, unknown>) =>
  dispatcherExecutors[name]!(ctx, input) as Promise<Result>;

describe("support tools", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("refuses every support tool to an agent that is not the default agent", async () => {
    const { worker, ctxFor } = await setUp("Refused");
    const ctx = ctxFor(worker.id);
    for (const [name, input] of [
      ["set_brief", { brief: "A page about the person." }],
      ["hire_agent", { name: "Rex", role: "Friend", kind: "companion", jobDescription: "Be good company in the evenings." }],
      ["read_agent_memory", { agent: "Mina" }],
      ["remember_for_agent", { agent: "Mina", body: "Writes for teenagers." }],
      ["correct_agent_memory", { agent: "Mina", oldBody: "Writes for teenagers.", body: "Writes for parents." }],
    ] as const) {
      expect(await call(name, ctx, input)).toEqual({ error: "This tool is not available to you." });
    }
  });

  it("lets an agent created with only a name write its own profile, once", async () => {
    const { account, worker, ctxFor } = await setUp("Blank agent");
    const blank = await createAgent(db, account.id, { name: "Nova", label: "Nova", provider: "openai", modelId: "gpt-5", markColor: "#FFCC38" });
    expect(blank).toMatchObject({ role: UNSET_ROLE, kind: "work", markColor: "#FFCC38" });
    expect(isUnsetAgent(blank)).toBe(true);
    expect(isUnsetAgent(worker)).toBe(false);

    const profile = {
      role: "Research assistant",
      personality: "Calm and precise, with short answers.",
      jobDescription: "Find and summarise sources for the weekly newsletter, and flag anything that needs a second look.",
    };
    // An agent that already has a job cannot rewrite it.
    expect(((await dispatcherExecutors.set_my_profile!(ctxFor(worker.id), profile)) as Result).error).toMatch(/already set/);
    expect(((await dispatcherExecutors.set_my_profile!(ctxFor(blank.id), { role: "x" })) as Result).error).toMatch(/Invalid/);

    expect(await dispatcherExecutors.set_my_profile!(ctxFor(blank.id), profile)).toMatchObject({ saved: true });
    const [saved] = await db.select().from(agents).where(eq(agents.id, blank.id));
    expect(saved).toMatchObject({ ...profile, kind: "work" });
    expect(isUnsetAgent(saved!)).toBe(false);
    expect(((await dispatcherExecutors.set_my_profile!(ctxFor(blank.id), profile)) as Result).error).toMatch(/already set/);
  });

  it("saves the brief for the whole account and caps its length", async () => {
    const { account, support, ctxFor } = await setUp("Briefed");
    const ctx = ctxFor(support.id);
    expect(await call("set_brief", ctx, { brief: "short" })).toHaveProperty("error");
    expect(await call("set_brief", ctx, { brief: "x".repeat(4_001) })).toHaveProperty("error");
    expect(await call("set_brief", ctx, { brief: "## Business\nSells handmade soap to parents of young children." })).toMatchObject({ saved: true });
    expect(await briefFor(db, account.id)).toContain("handmade soap");
  });

  it("hires an agent of the chosen kind on the caller's model, with its own chat", async () => {
    const { account, support, ctxFor } = await setUp("Hiring");
    const ctx = ctxFor(support.id);
    const hired = await call("hire_agent", ctx, {
      name: "Rosa",
      role: "Spanish partner",
      kind: "companion",
      personality: "Patient and playful.",
      jobDescription: "Chat in simple Spanish every evening and gently correct mistakes.",
    });
    expect(hired).toMatchObject({ name: "Rosa", kind: "companion" });
    const [row] = await db.select().from(agents).where(eq(agents.id, String(hired.agentId)));
    expect(row).toMatchObject({ accountId: account.id, kind: "companion", provider: support.provider, modelId: support.modelId, parentId: null });
    const [room] = await db.select().from(conversations).where(eq(conversations.id, String(hired.conversationId)));
    expect(room).toMatchObject({ kind: "direct", ownerAgentId: row!.id });
    // The person gets a card linking to the new agent.
    expect(ctx.emittedMessages).toHaveLength(1);

    // The hired agent opens its own chat, so the person never meets an empty screen.
    const hello = await waitFor(async () => {
      const rows = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
      return rows.length > 0 ? rows : null;
    });
    expect(hello).toHaveLength(1);
    expect(hello![0]).toMatchObject({ agentId: row!.id, body: "Hi, I'm here and ready when you are." });

    const clash = await call("hire_agent", ctx, {
      name: "rosa",
      role: "Friend",
      kind: "companion",
      personality: "Easygoing and kind.",
      jobDescription: "Be good company in the evenings.",
    });
    // A personality is required, so no agent sounds like a generic assistant.
    expect(
      await call("hire_agent", ctx, { name: "Nia", role: "Friend", kind: "companion", jobDescription: "Be good company in the evenings." }),
    ).toHaveProperty("error");
    expect(String(clash.error)).toContain("already exists");
    expect(await call("hire_agent", ctx, { name: "Sam", role: "Boss", kind: "support", jobDescription: "Run all the other agents." })).toHaveProperty("error");
  });

  it("reads, adds to and corrects another agent's own memory, and stays inside the account", async () => {
    const { account, worker, support, ctxFor } = await setUp("Memory");
    const outsider = await setUp("Elsewhere");
    const ctx = ctxFor(support.id);

    expect(await call("remember_for_agent", ctx, { agent: "Mina", body: "The audience is teenagers.", kind: "fact" })).toMatchObject({ agent: "Mina" });
    const read = await call("read_agent_memory", ctx, { agent: "Mina" });
    expect((read.facts as { body: string }[]).map((fact) => fact.body)).toEqual(["The audience is teenagers."]);

    expect(await call("correct_agent_memory", ctx, { agent: "Mina", oldBody: "The audience is adults.", body: "x y z" })).toHaveProperty("error");
    await call("correct_agent_memory", ctx, {
      agent: "Mina",
      oldBody: "The audience is teenagers.",
      body: "The audience is parents of young children.",
    });
    const current = await db
      .select({ body: memories.body })
      .from(memories)
      .where(and(eq(memories.accountId, account.id), eq(memories.agentId, worker.id), isNull(memories.supersededBy)));
    expect(current.map((fact) => fact.body)).toEqual(["The audience is parents of young children."]);
    // The replaced fact is kept as history.
    const all = await db.select().from(memories).where(and(eq(memories.accountId, account.id), eq(memories.agentId, worker.id)));
    expect(all).toHaveLength(2);

    // Another account's agent cannot be reached by id.
    const foreign = await call("read_agent_memory", ctx, { agent: outsider.worker.id });
    expect(String(foreign.error)).toContain("No agent called");
  });
});

describe("copiedContextSections", () => {
  it("finds sections of the agent's own context copied into a brief", async () => {
    const { copiedContextSections } = await import("./executors.js");
    expect(copiedContextSections("# Mo\n## Goals\n- Sell\n## Now\nTime\n## Memory\n- x\n### Profile\nold")).toEqual(["Now", "Memory", "Profile"]);
    expect(copiedContextSections("# Mo\n## Who does what\n- Ethan: Fiverr")).toEqual([]);
  });
});
