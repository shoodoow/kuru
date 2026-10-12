import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations, members, messages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createAccount, createAgent } from "../roster/roster.js";
import { saveUserMessage } from "./rooms.js";
import { runTurn, toModelPrompt } from "./turn.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

describe("toModelPrompt", () => {
  it("keeps system text out of the message list", () => {
    const prompt = toModelPrompt({
      provider: "openai",
      prefix: "identity",
      tail: "summary",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(prompt.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(prompt.instructions.map((item) => item.content)).toEqual(["identity", "summary"]);
  });
});

describe("runTurn", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("calls the model once for the mentioned agent and once for the owner when nobody is mentioned", async () => {
    const account = await createAccount(db, { name: "Room" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const cy = await createAgent(db, account.id, agent("Cy"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: cy.id, title: "desk" })
      .returning();
    await db.insert(members).values([ada, bea, cy].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));

    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada look", async ({ agentId }) => {
      calls.push(agentId);
      return "done";
    });
    expect(calls).toEqual([ada.id]);

    calls.length = 0;
    await runTurn(db, account.id, room!.id, "anyone?", async ({ agentId }) => {
      calls.push(agentId);
      return "owner reply";
    });
    expect(calls).toEqual([cy.id]);

    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.agentId === ada.id)).toHaveLength(1);
    expect(stored.filter((message) => message.agentId === cy.id)).toHaveLength(1);
    expect(stored.filter((message) => message.agentId === bea.id)).toHaveLength(0);
  });

  it("answers a message that arrived during the turn without waiting for the scheduler", async () => {
    const account = await createAccount(db, { name: "Queue" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: ada.id, title: "queue" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: ada.id });
    const seen: string[] = [];
    await runTurn(db, account.id, room!.id, "first", async ({ messages: modelMessages }) => {
      seen.push(JSON.stringify(modelMessages));
      if (seen.length === 1) {
        await saveUserMessage(db, account.id, room!.id, { text: "second", queued: true });
      }
      return "ok";
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("second");
    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.body === "second")).toHaveLength(1);
    expect(stored.find((message) => message.body === "second")?.queued).toBe(false);
  });

  it("lets a reply mention the next agent once", async () => {
    const account = await createAccount(db, { name: "Chain" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: ada.id, title: "chain" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada start", async ({ agentId }) => {
      calls.push(agentId);
      if (agentId === bea.id) return "finished";
      return calls.filter((id) => id === ada.id).length === 1 ? "@Bea your turn" : "all done";
    });
    // Bea names nobody, so the floor returns to Ada (the lead), who closes the round.
    expect(calls).toEqual([ada.id, bea.id, ada.id]);
  });

  it("lets two agents hand work back and forth, and stops at the round cap", async () => {
    const account = await createAccount(db, { name: "Loop" });
    const ada = await createAgent(db, account.id, { name: "Ada", label: "Ada", role: "Writer", jobDescription: "Write.", provider: "openai", modelId: "gpt-5" });
    const bea = await createAgent(db, account.id, { name: "Bea", label: "Bea", role: "Reviewer", jobDescription: "Review.", provider: "openai", modelId: "gpt-5" });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: ada.id, title: "loop" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({ conversationId: room!.id, accountId: account.id, agentId: member.id })));
    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada start", async ({ agentId }) => {
      calls.push(agentId);
      return agentId === ada.id ? "Draft attached. @bea please review" : "Not yet.\n@Ada tighten the hook";
    });
    expect(calls.slice(0, 4)).toEqual([ada.id, bea.id, ada.id, bea.id]);
    expect(calls.length).toBe(8);
  });

  it("wakes the mentioned agent from anywhere in a user message, nobody else", async () => {
    const account = await createAccount(db, { name: "Strict" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const cy = await createAgent(db, account.id, agent("Cy"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: cy.id, title: "strict" })
      .returning();
    await db.insert(members).values([ada, bea, cy].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "can someone loop in @Bea here?", async ({ agentId }) => {
      calls.push(agentId);
      return "on it";
    });
    expect(calls).toEqual([bea.id]);
  });

  it("ignores inline mentions inside an agent reply (leading @ is a handoff)", async () => {
    const account = await createAccount(db, { name: "NoChain" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: ada.id, title: "nochian" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada go", async ({ agentId }) => {
      calls.push(agentId);
      return "thanks @Bea for the earlier help, done here";
    });
    expect(calls).toEqual([ada.id]);
  });

  it("saves a reply when the model calls tools and returns no text", async () => {
    const account = await createAccount(db, { name: "Tools" });
    const owner = await createAgent(db, account.id, agent("Tools"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "tools" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: owner.id });

    await runTurn(db, account.id, room!.id, "read the file", async () => ({ text: "   " }));

    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.agentId === null)).toHaveLength(1);
    expect(stored.find((message) => message.agentId === owner.id)?.body).toBe(
      "I didn’t finish that. Tell me to try again.",
    );
  });

  it("posts plain text as the reply, whatever its wording", async () => {
    const account = await createAccount(db, { name: "Stall" });
    const owner = await createAgent(db, account.id, agent("Stall"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "stall" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: owner.id });

    await runTurn(db, account.id, room!.id, "Ok do it", async () => ({
      text: "I'll keep an eye on it and let you know.",
    }));

    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.find((message) => message.agentId === owner.id)?.body).toBe(
      "I'll keep an eye on it and let you know.",
    );
  });

  it("runs overlapping turns one after another", async () => {
    const account = await createAccount(db, { name: "Lock" });
    const owner = await createAgent(db, account.id, agent("Owner"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "lock" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: owner.id });

    const log: string[] = [];
    const generate = async () => {
      log.push("start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      log.push("end");
      return "ok";
    };
    await Promise.all([
      runTurn(db, account.id, room!.id, "first", generate),
      runTurn(db, account.id, room!.id, "second", generate),
    ]);
    expect(log).toEqual(["start", "end", "start", "end"]);
  });

});

function agent(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
