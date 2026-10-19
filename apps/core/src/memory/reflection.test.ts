import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agentReflections, conversations, delegations, memories, messages, reactions } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { remember } from "./memory.js";
import { clipBody, RULE_BUDGET, localHour, measureHealth, parseReflection, parseSignals, reflectAgent, textProblem, undoReflection } from "./reflection.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

async function setUp(name: string) {
  const account = await createAccount(db, { name });
  const nora = await createAgent(db, account.id, { name: "Nora", label: "Nora", role: "Video lead", jobDescription: "Makes videos.", provider: "openai", modelId: "gpt-5" });
  const [room] = await db.insert(conversations).values({ accountId: account.id, kind: "direct", ownerAgentId: nora.id, title: "Nora" }).returning();
  const say = async (body: string, fromAgent = false) =>
    (await db.insert(messages).values({ accountId: account.id, conversationId: room!.id, agentId: fromAgent ? nora.id : null, body }).returning())[0]!;
  return { account, nora, room: room!, say };
}

const current = (accountId: string, agentId: string) =>
  db
    .select({ body: memories.body, kind: memories.kind, confirmed: memories.confirmed, tentative: memories.tentative })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.agentId, agentId), isNull(memories.supersededBy)));

describe("reflection", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("reads its line format with the evidence each edit rests on, including jobs", () => {
    expect(
      parseReflection(
        "Here you go:\nrule: keep text at least 32px [M3, M7]\nrule: cap ffmpeg concurrency [J1]\nconfirm R2 [M5]\nreplace F1: launch moved to Monday [M9]\nmerge R1 R4: one rule\nretire F2 [M11]\nnothing\nchatter",
      ),
    ).toEqual([
      { op: "rule", body: "keep text at least 32px", evidence: ["M3", "M7"] },
      { op: "rule", body: "cap ffmpeg concurrency", evidence: ["J1"] },
      { op: "confirm", target: "R2", evidence: ["M5"] },
      { op: "replace", target: "F1", body: "launch moved to Monday", evidence: ["M9"] },
      { op: "merge", targets: ["R1", "R4"], body: "one rule" },
      { op: "retire", target: "F2", evidence: ["M11"] },
    ]);
  });

  it("soft-clips oversized rule bodies at sentence or word boundaries", () => {
    const long = "Always check audio levels before export. When rendering launch videos, make sure the video bitrate is set properly to 12Mbps so that mobile playback is smooth and there are no compression artifacts on high-resolution displays. " + "Extra sentence that runs far over the limit.".repeat(5);
    const clipped = clipBody(long, 300);
    expect(clipped.length).toBeLessThanOrEqual(300);
    expect(clipped.endsWith(".")).toBe(true);
  });

  it("tells the person's hour from their zone, falling back to UTC", () => {
    const at = new Date("2026-10-16T00:30:00Z");
    expect(localHour("Asia/Tehran", at)).toBe(4);
    expect(localHour("", at)).toBe(0);
    expect(localHour("Not/AZone", at)).toBe(0);
  });

  it("turns down text that names a skill the agent lacks, holds a secret, or runs long", () => {
    const names = new Set(["hyperframes", "browser_click", "ffmpeg", "kokoro"]);
    expect(textProblem("For launch videos use `hyperframes` and its creative guide.", names)).toBeNull();
    expect(textProblem("Process audio using `ffmpeg` and voice with `kokoro`.", names)).toBeNull();
    expect(textProblem("Use /product-launch-video for every launch video.", names)).toMatch(/product-launch-video/);
    expect(textProblem("The api_key: abcdef is stored here.", names)).toMatch(/secret/);
    expect(textProblem("x".repeat(400), names)).toMatch(/longer/);
    expect(parseSignals("correction M2 M4\npraise [M5]\n- correction: M4\nrule: x [M1]")).toEqual({ corrections: ["M2", "M4"], praise: ["M5"] });
  });

  it("lets a manual reflection read back over recent days after the last run", async () => {
    const { account, nora, say } = await setUp("reflect-lookback");
    await say("Keep numbers centered on screen.");
    const first = await reflectAgent(db, account.id, nora.id, { think: async () => "rule: keep numbers centered on screen [M1]" });
    expect(first.status).toBe("applied");
    // Nothing new since that run: the nightly path skips, a manual one still reads the message.
    expect((await reflectAgent(db, account.id, nora.id, { think: async () => "nothing" })).status).toBe("skipped");
    const manual = await reflectAgent(db, account.id, nora.id, { lookBackMs: 24 * 60 * 60 * 1000, think: async () => "nothing" });
    expect(manual.status).not.toBe("skipped");
  });

  it("turns down a new rule over budget unless the same pass retires one", async () => {
    const { account, nora, say } = await setUp("reflect-budget");
    const said = await say("Use the new recipe file for every reel.");
    for (let i = 0; i < RULE_BUDGET; i++) {
      await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: `Old rule number ${i} about reels.`, messageId: said.id });
    }
    const full = await reflectAgent(db, account.id, nora.id, {
      since: new Date(Date.now() - 60_000),
      think: async () => "rule: for every reel, follow REEL-RECIPE.md exactly [M1]",
    });
    expect(full.edits.find((edit) => edit.op === "rule")?.dropped).toMatch(/budget/);
    const freed = await reflectAgent(db, account.id, nora.id, {
      since: new Date(Date.now() - 60_000),
      think: async () => "retire R1 [M1]\nrule: for every reel, follow REEL-RECIPE.md exactly [M1]",
    });
    expect(freed.edits.find((edit) => edit.op === "rule")?.dropped).toBeUndefined();
  });

  it("learns firm rules from the person, tentative ones from jobs, keeps what is confirmed, and can be undone", async () => {
    const { account, nora, say } = await setUp("reflect-learn");
    const quiet = await reflectAgent(db, account.id, nora.id, { think: async () => "rule: should not be written [M1]" });
    expect(quiet.status).toBe("skipped");

    const said = await say("The text is too small and the music is missing. Redo it.");
    const reply = await say("Rebuilt with bigger text and a music bed.", true);
    await db.insert(reactions).values({ accountId: account.id, messageId: reply.id, emoji: "👍" });
    const cut = await say("Here is the shorter cut.", true);
    await db.insert(reactions).values({ accountId: account.id, messageId: cut.id, emoji: "👎" });
    await db.insert(delegations).values({ accountId: account.id, conversationId: said.conversationId, parentAgentId: nora.id, childAgentId: nora.id, task: "Render", status: "failed", result: "Ran out of memory at 4 workers." });
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: "Render drafts at 720p before the final.", messageId: said.id });
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "fact", body: "The launch is on Friday.", messageId: said.id });

    let seen = "";
    const result = await reflectAgent(db, account.id, nora.id, {
      since: new Date(Date.now() - 60_000),
      think: async (_system: string, user: string) => {
        seen = user;
        return [
          "rule: in launch videos keep text at least 32px at 1080p and always add a music bed [M1]",
          "rule: render with at most 2 workers on this computer to avoid running out of memory [J1]",
          "confirm R1 [M2]",
          "retire F1 [M1]",
          "rule: invented without evidence",
          "rule: use /secret-skill for everything [M1]",
          "rule: Render drafts at 720p, before the final! [M1]",
          "correction M1",
          "praise M2",
        ].join("\n");
      },
    });
    expect(seen).toContain("M1 Person: The text is too small");
    expect(seen).toContain("[the person reacted 👍]");
    expect(seen).toContain("[the person reacted 👎 (did not like it)]");
    expect(seen).toContain("J1 [failed] Render");
    expect(seen).toContain("Ran out of memory");
    expect(result.status).toBe("applied");
    expect(result.applied).toBe(4);
    expect(result.edits.filter((edit) => edit.dropped).map((edit) => edit.dropped)).toEqual(["cites no message it read", "names secret-skill, which this agent does not have", "already there as R1"]);
    expect(result.note).toMatch(/Learned 2 rules/);
    // Only the person's messages count; praise on the agent's line is not theirs.
    // A reaction counts by its tone: 👍 is a reward, 👎 a correction.
    expect(result.health.measured).toMatchObject({ corrections: 2, rewards: 1 });

    const rows = await current(account.id, nora.id);
    expect(rows.find((row) => row.body.startsWith("in launch videos"))).toMatchObject({ kind: "procedure", tentative: false });
    // Rests only on the background job, so it waits to be confirmed.
    expect(rows.find((row) => row.body.startsWith("render with at most 2"))).toMatchObject({ tentative: true });
    expect(rows.find((row) => row.body.startsWith("Render drafts"))).toMatchObject({ confirmed: 1 });
    expect(rows.some((row) => row.body === "The launch is on Friday.")).toBe(false);

    expect(await undoReflection(db, account.id, result.id!)).toBe(true);
    const restored = await current(account.id, nora.id);
    expect(restored.map((row) => row.body).sort()).toEqual(["Render drafts at 720p before the final.", "The launch is on Friday."]);
    expect(restored.find((row) => row.body.startsWith("Render drafts"))).toMatchObject({ confirmed: 0 });
    const [journal] = await db.select().from(agentReflections).where(eq(agentReflections.id, result.id!));
    expect(journal?.status).toBe("undone");
  });

  it("proposes without writing in a dry run, and measures health without an embedder", async () => {
    const { account, nora, say } = await setUp("reflect-dry");
    const said = await say("Never post before 9am.");
    const dry = await reflectAgent(db, account.id, nora.id, { since: new Date(Date.now() - 60_000), dryRun: true, think: async () => "rule: never post before 9am [M1]" });
    expect(dry.status).toBe("dry");
    expect(dry.edits).toHaveLength(1);
    expect(await current(account.id, nora.id)).toHaveLength(0);

    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: "Send the finished MP4 for video reviews, not screenshots", messageId: said.id });
    await remember(db, account.id, { scope: "agent", agentId: nora.id, kind: "procedure", body: "For video reviews send the finished MP4, never screenshots", messageId: said.id });
    // No embedding key: look-alikes are not guessed from words; the reflection merges them.
    const health = await measureHealth(db, account.id, nora.id);
    expect(health.measured.duplicates).toBeNull();
    expect(health.issues.join(" ")).not.toMatch(/mean nearly the same/);
  });
});
