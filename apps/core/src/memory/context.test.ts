import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildInstructions } from "../prompt/build-instructions.js";
import { buildContext, personLine, roomLine, turnRule } from "./context.js";
import { getDb } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { runTurn } from "../rooms/turn.js";

const identity = { name: "Ada", role: "Ledger keeper", personality: "", job: "Keep the ledger." };

const agent = {
  accountId: "account-1",
  agentId: "agent-1",
  promptVersion: 3,
  identity,
};

describe("buildContext", () => {
  it("shows the account brief in the tail, capped, and nothing when there is none", () => {
    const withBrief = buildContext({ ...agent, summary: [], messages: [], brief: `Sells handmade soap. ${"x".repeat(5_000)}` });
    const without = buildContext({ ...agent, summary: [], messages: [], brief: "  " });
    expect(withBrief.tail).toContain("## Brief");
    expect(withBrief.tail).toContain("Sells handmade soap.");
    expect(withBrief.tail.length).toBeLessThan(4_600);
    expect(withBrief.prefix).toBe(without.prefix);
    expect(without.tail).not.toContain("## Brief");
  });

  it("keeps the prefix stable and puts cited durable context only in the tail", () => {
    const first = buildContext({
      ...agent,
      summary: [{ key: "decisions", body: "Ship on Friday.", messageId: "message-1" }],
      messages: [{ body: "first note" }],
    });
    const second = buildContext({
      ...agent,
      summary: [{ key: "decisions", body: "Ship on Monday." }],
      messages: [{ body: "second note" }],
    });

    expect(first.prefix).toBe(`${buildInstructions(identity)}\n\n${turnRule()}`);
    expect(first.prefix.endsWith(turnRule())).toBe(true);
    expect(first.prefix).toBe(second.prefix);
    expect(first.prefix.includes("Ship on Friday.")).toBe(false);
    expect(first.prefix.includes("first note")).toBe(false);
    expect(first.tail.includes("Ship on Friday. [msg:message-1]")).toBe(true);
    expect(first.tail.includes("first note")).toBe(false);
    expect(second.tail.includes("second note")).toBe(false);
  });

  it("marks only the prefix for Anthropic and keys the OpenAI cache by account, agent, and prompt version", () => {
    const context = buildContext({
      ...agent,
      summary: [{ key: "topics", body: "Billing." }],
      messages: [{ body: "hello" }],
    });
    expect(context.anthropic.prefix.cacheControl).toEqual({ type: "ephemeral" });
    expect(context.anthropic.tail).toEqual({ body: context.tail });
    expect(context.openai.promptCacheKey).toBe("account-1:agent-1:3");
    const long = buildContext({
      ...agent,
      accountId: "6270c871-e778-44e2-ad9b-cf8c639da2fa",
      agentId: "11111111-1111-1111-1111-111111111111",
      summary: [],
      messages: [],
    });
    expect(long.openai.promptCacheKey).toHaveLength(64);
    expect(context.openai.promptCacheRetention).toBe("24h");
    expect("truncation" in context.openai).toBe(false);
  });

  it("grounds the room situation as the first tail line", () => {
    expect(roomLine({ title: "Group 1", kind: "group", members: ["Grok", "Jimmy", "Mossy"], selfName: "Jimmy" })).toBe(
      '"Group 1" (group of 3). Members: Grok, Jimmy, Mossy. You are Jimmy.',
    );
    const withRoom = buildContext({
      ...agent,
      summary: [],
      messages: [{ body: "hi" }],
      room: { title: "Group 1", kind: "group", members: ["Jimmy", "Mossy"], selfName: "Jimmy" },
    });
    expect(withRoom.tail.startsWith('## Room\n"Group 1"')).toBe(true);
    expect(withRoom.prefix.includes("Group 1")).toBe(false);
  });

  it("puts the tool contract after skill names and names the person in the tail", () => {
    const now = new Date("2026-10-06T10:52:00.000Z");
    const context = buildContext({
      ...agent,
      summary: [],
      messages: [],
      catalog: "docx\npptx",
      room: { title: "Launch crew", kind: "group", members: ["Sara", "Maya-ruuc"], selfName: "Sara" },
      person: {
        name: "Mohammad Reza",
        timezone: "Asia/Riyadh",
        now,
        teammates: [{ label: "Maya", role: "researcher", mention: "Maya-ruuc" }],
      },
    });
    expect(context.prefix.endsWith(turnRule())).toBe(true);
    expect(context.prefix.indexOf("docx")).toBeLessThan(context.prefix.lastIndexOf(turnRule()));
    expect(context.prefix.includes("Recent trends")).toBe(false);
    expect(context.tail.startsWith('## Room\n"Launch crew"')).toBe(true);
    // The roster sits near the top; the clock, which changes every minute, closes the tail.
    const [roster, clock] = personLine({
      name: "Mohammad Reza",
      timezone: "Asia/Riyadh",
      now,
      teammates: [{ label: "Maya", role: "researcher", mention: "Maya-ruuc" }],
    }).split("\nTimezone:");
    expect(context.tail).toContain(roster);
    expect(context.tail.endsWith(`## Now\nTimezone:${clock}`)).toBe(true);
    expect(context.tail).toContain("You speak to them");
    expect(context.tail).toContain("They are not a teammate");
    expect(context.tail).toContain("Maya (researcher, mention @Maya-ruuc)");
    expect(context.prefix.includes("Mohammad Reza")).toBe(false);
  });

  it("renders copy-pasteable team ids and generic groups", () => {
    const now = new Date("2026-10-06T10:52:00.000Z");
    const line = personLine({
      name: "A",
      timezone: "Asia/Riyadh",
      now,
      teammates: [{ id: "11111111-1111-1111-1111-111111111111", label: "Maya", role: "researcher", mention: "Maya-ruuc" }],
      groups: [{ id: "22222222-2222-2222-2222-222222222222", title: "Crew", memberCount: 4 }],
    });
    expect(line).toContain("- Maya (researcher, @Maya-ruuc, id:11111111-1111-1111-1111-111111111111)");
    expect(line).toContain('- "Crew" (id:22222222-2222-2222-2222-222222222222, 4 members)');
  });

  it("says the timezone is unknown when none is stored", () => {
    const line = personLine({
      name: "Mohammad Reza",
      timezone: "",
      now: new Date("2026-10-06T10:52:00.000Z"),
      teammates: [],
      groups: [],
    });
    expect(line).toContain("Timezone: unknown. Do not invent one.");
    expect(line).toContain("Team: none.");
    expect(line).toContain("Groups: none.");
    expect(line.includes("Local time now")).toBe(false);
  });

  it("renders active background workers in the tail without polluting the prefix", () => {
    const withWorkers = buildContext({
      ...agent,
      summary: [],
      messages: [{ body: "What are you doing?" }],
      activeWorkers: [
        { childAgentId: "worker-1", task: "Install htop on the system", createdAt: new Date() },
      ],
    });
    expect(withWorkers.prefix.includes("worker-1")).toBe(false);
    expect(withWorkers.tail.includes("## Work in progress")).toBe(true);
    expect(withWorkers.tail.includes("worker-1")).toBe(true);
    expect(withWorkers.tail.includes("Install htop on the system")).toBe(true);
    // An agent that can start work is told outright when nothing is running.
    const idle = buildContext({ ...agent, summary: [], messages: [{ body: "Is it done?" }], activeWorkers: [] });
    expect(idle.tail).toContain("## Work in progress\nNothing is running right now.");
    expect(withWorkers.tail.includes("redirect_worker")).toBe(false);
  });

  it("renders bounded employee work history without raw logs", () => {
    const withHistory = buildContext({
      ...agent,
      summary: [],
      messages: [],
      workHistory: [
        {
          kind: "routine",
          title: "Weekly campaign report",
          outcome: "Published the report and flagged declining conversion.",
          status: "done",
          createdAt: new Date("2026-10-03T10:00:00.000Z"),
        },
      ],
    });
    expect(withHistory.tail).toContain("## Recent work");
    expect(withHistory.tail).toContain("Weekly campaign report");
    expect(withHistory.tail).toContain("declining conversion");
  });
});

describe("runTurn prefix", () => {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
  const db = getDb(databaseUrl);

  afterAll(async () => {
    await db.$client.end();
  });

  it("reuses the prefix on the next turn and stores the reported cache read tokens", async () => {
    const account = await createAccount(db, { name: "Cache" });
    const owner = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Ledger keeper",
      jobDescription: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "cache" })
      .returning();
    const prefixes: string[] = [];
    const tails: string[] = [];
    const generate = async (input: { prefix: string; tail: string }) => {
      prefixes.push(input.prefix);
      tails.push(input.tail);
      return { text: "noted", cacheReadTokens: 40 };
    };
    await runTurn(db, account.id, room!.id, "first", generate);
    await runTurn(db, account.id, room!.id, "second", generate);
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(prefixes[1]?.includes("noted")).toBe(false);
    expect(tails[1]?.includes("noted")).toBe(false);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.agentId).map((message) => message.cacheReadTokens)).toEqual([40, 40]);
  });
});
