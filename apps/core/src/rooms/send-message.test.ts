import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import { conversations, members, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { blocksToText, saveReaction, saveSendMessage, isSafeImageUrl } from "./send-message.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/**
 * Locks rich-turn voice behavior: multi-block inserts stay ordered, reactions
 * are idempotent, and unsafe image URLs are rejected before touching the DB.
 */
describe("send_message protocol", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("converts blocks to searchable text with fallbacks", () => {
    expect(blocksToText([{ kind: "text", markdown: "hello" }])).toBe("hello");
    expect(blocksToText([{ kind: "image", url: "https://x/y.png", alt: "cat" }])).toBe("[image: cat]");
    expect(blocksToText([{ kind: "widget", widget: "checklist", props: {} }])).toBe("(Shown to the person as a checklist card)");
    // The agent reads this back as history, so it must say what was asked and
    // answered, and must not look like markup the model could copy.
    const asked = blocksToText([
      { kind: "widget", widget: "question", props: { prompt: "What brings you here?", options: [{ label: "A business" }, "Just to talk"] } },
    ]);
    expect(asked).toBe('(Shown to the person as a tappable question card: "What brings you here?" Choices: A business | Just to talk. Not answered yet.)');
    expect(asked).not.toContain("[widget:");
    expect(
      blocksToText([{ kind: "widget", widget: "question", props: { prompt: "When?", options: ["Now", "Later"], selected: "Later" } }]),
    ).toContain("They picked: Later.");
  });

  it("rejects non-https image urls", () => {
    expect(isSafeImageUrl("https://cdn.example/pic.png")).toBe(true);
    expect(isSafeImageUrl("http://evil.example/pic.png")).toBe(false);
    expect(isSafeImageUrl("data:image/png;base64,iVBOR")).toBe(true);
  });

  it("saves two bubbles in order plus an idempotent reaction", async () => {
    const account = await createAccount(db, { name: "Voice" });
    const agent = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      role: "Teammate",
      jobDescription: "Speaks in bubbles.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: agent.id, title: "voice" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: agent.id });

    const saved = await db.transaction(async (tx) => {
      const first = await saveSendMessage(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        agentId: agent.id,
        blocks: [{ kind: "text", markdown: "On it, checking now." }],
        createdAt: new Date(1000),
      });
      const second = await saveSendMessage(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        agentId: agent.id,
        blocks: [
          { kind: "text", markdown: "Found it." },
          { kind: "image", url: "https://cdn.example/shot.png", alt: "screen" },
        ],
        replyTo: first.id,
        createdAt: new Date(1001),
      });
      const r1 = await saveReaction(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        agentId: agent.id,
        messageId: first.id,
        emoji: "👍",
      });
      const r2 = await saveReaction(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        agentId: agent.id,
        messageId: first.id,
        emoji: "👍",
      });
      return { first, second, r1, r2 };
    });

    expect(saved.second.replyTo).toBe(saved.first.id);
    expect(saved.second.body).toContain("Found it.");
    expect(saved.r1.created).toBe(true);
    expect(saved.r2.created).toBe(false);
    expect(saved.r1.reaction.id).toBe(saved.r2.reaction.id);
    await expect(
      db.transaction(async (tx) =>
        saveSendMessage(tx as never, {
          accountId: account.id,
          conversationId: room!.id,
          agentId: agent.id,
          blocks: [{ kind: "image", url: "http://evil.example/x.png" }],
          createdAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("mirrors a teammate group ping into the owner's private chat only when @mentioned", async () => {
    const account = await createAccount(db, { name: "Mirror" });
    const owner = await createAgent(db, account.id, {
      name: "Sara",
      label: "Sara",
      role: "Assistant",
      jobDescription: "Leads the crew.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const maya = await createAgent(db, account.id, {
      name: "Maya",
      label: "Maya",
      role: "Researcher",
      jobDescription: "Finds a comparable project.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [dm] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "Sara" })
      .returning();
    const [group] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: owner.id, title: "Launch crew" })
      .returning();
    await db.insert(members).values([
      { conversationId: dm!.id, accountId: account.id, agentId: owner.id },
      { conversationId: group!.id, accountId: account.id, agentId: owner.id },
      { conversationId: group!.id, accountId: account.id, agentId: maya.id },
    ]);

    await saveSendMessage(db, {
      accountId: account.id,
      conversationId: group!.id,
      agentId: maya.id,
      viaAgentId: owner.id,
      blocks: [{ kind: "text", markdown: "Closest fit is OpenHands." }],
      createdAt: new Date(),
    });
    await saveSendMessage(db, {
      accountId: account.id,
      conversationId: group!.id,
      agentId: owner.id,
      blocks: [{ kind: "text", markdown: "Thanks, I'll take it from here." }],
      createdAt: new Date(),
    });
    await saveSendMessage(db, {
      accountId: account.id,
      conversationId: group!.id,
      agentId: maya.id,
      blocks: [{ kind: "text", markdown: "@Sara closest fit is OpenHands." }],
      createdAt: new Date(),
    });

    const copies = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, dm!.id), eq(messages.accountId, account.id)));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.agentId).toBe(maya.id);
    expect(copies[0]?.viaAgentId).toBeNull();
    expect(copies[0]?.body).toContain("@Sara");
    expect(copies[0]?.relayKind).toBe("from");
    expect(copies[0]?.sourceConversationId).toBe(group!.id);
  });
});
