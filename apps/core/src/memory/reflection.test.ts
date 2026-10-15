import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, memories, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { remember } from "./memory.js";
import { parseReflection, reflectAgent } from "./reflection.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

describe("reflection", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("reads only lines in its format, at most eight", () => {
    expect(
      parseReflection("Here you go:\nrule: when making a launch video, keep text at least 32px\nreplace R2: send drafts as MP4\nretire F1\nnothing\nsome chatter"),
    ).toEqual([
      { op: "rule", body: "when making a launch video, keep text at least 32px" },
      { op: "replace", target: "R2", body: "send drafts as MP4" },
      { op: "retire", target: "F1" },
    ]);
    expect(parseReflection(Array.from({ length: 12 }, (_, index) => `fact: fact number ${index}`).join("\n"))).toHaveLength(8);
    expect(parseReflection("nothing")).toEqual([]);
  });

  it("turns a day's corrections into rules, rewords one and retires one, and skips a day without the person", async () => {
    const account = await createAccount(db, { name: "Reflect" });
    const nora = await createAgent(db, account.id, { name: "Nora", label: "Nora", role: "Video lead", jobDescription: "Makes videos.", provider: "openai", modelId: "gpt-5" });
    const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: nora.id, title: "Nora" }).returning();
    const since = new Date(Date.now() - 60_000);
    const quiet = await reflectAgent(db, account.id, nora.id, since, async () => "rule: should not be written");
    expect(quiet.applied).toBe(0);

    const [said] = await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, body: "The text is too small and the music is missing. Redo it." }).returning();
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: "Render drafts at 720p.", messageId: said!.id });
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "fact", body: "The launch is on Friday.", messageId: said!.id });

    let seen = "";
    const result = await reflectAgent(db, account.id, nora.id, since, async (_system, user) => {
      seen = user;
      return "rule: in launch videos keep text at least 32px at 1080p and always add a music bed\nreplace R1: render drafts at 720p, final at 1080p\nretire F1";
    });
    expect(seen).toContain("The text is too small");
    expect(seen).toContain("R1: Render drafts at 720p.");
    expect(result.applied).toBe(3);

    const current = await db
      .select({ body: memories.body, kind: memories.kind })
      .from(memories)
      .where(and(eq(memories.accountId, account.id), eq(memories.agentId, nora.id), isNull(memories.supersededBy)));
    expect(current.map((row) => row.body).sort()).toEqual([
      "in launch videos keep text at least 32px at 1080p and always add a music bed",
      "render drafts at 720p, final at 1080p",
    ]);
    expect(current.every((row) => row.kind === "procedure")).toBe(true);
  });
});
