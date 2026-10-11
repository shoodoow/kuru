import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents, conversations, messages, proposals } from "../db/schema.js";
import { existsSync } from "node:fs";
import { exec } from "../linux/linux.js";
import { adoptHostSkills } from "./local.js";
import { approve, propose, reject } from "./proposals.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { startServer } from "../http/server.js";
import { runTurn } from "../rooms/turn.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("proposals", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("stores a cited proposal, and refuses one with no message id", async () => {
    const room = await openRoom("Cite");
    const message = await saveMessage(room, "Remember the Friday ship.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "memory",
      headers: { "content-type": "application/json" },
      body: "Ship on Friday.",
      messageIds: [message.id],
    });
    expect(saved.messageIds).toEqual([message.id]);
    expect(saved.status).toBe("pending");
    await expect(
      propose(db, room.accountId, {
        agentId: room.agentId,
        kind: "memory",
        headers: { "content-type": "application/json" },
        body: "No source.",
        messageIds: [],
      }),
    ).rejects.toThrow(/message/);
  });

  it("rejects without writing the skill or changing the prompt version", async () => {
    const room = await openRoom("Refuse");
    const skillsRoot = await mkdtemp(join(tmpdir(), "nano-proposals-"));
    const skillPath = join(skillsRoot, "letters", "SKILL.md");
    await mkdir(join(skillsRoot, "letters"));
    const original = "---\nname: letters\ndescription: Old.\n---\n\nOld body.\n";
    await writeFile(skillPath, original);
    const message = await saveMessage(room, "Try a new skill.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "skill",
      headers: { "content-type": "application/json" },
      body: "---\nname: letters\ndescription: New.\n---\n\nNew body.\n",
      messageIds: [message.id],
    });
    await reject(db, room.accountId, saved.id);
    expect(await readFile(skillPath, "utf8")).toBe(original);
    expect(await promptVersion(room.agentId)).toBe(1);
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("approves a skill, writes that file, and increments the prompt version", async () => {
    const room = await openRoom("Accept");
    const message = await saveMessage(room, "Learn the letter voice.");
    const body = "---\nname: letters\ndescription: Writes letters.\n---\n\nWrite in the client's voice.\n";
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "skill",
      body,
      messageIds: [message.id],
    });
    await approve(db, room.accountId, saved.id);
    // The skill is saved on the account's computer, where its agents read it.
    const written = await exec(room.accountId, ["cat", "/shared/skills/letters/SKILL.md"]);
    expect(written.stdout).toBe(body);
    expect(await promptVersion(room.agentId)).toBe(2);
  });

  it("moves skills an older version left on the server onto the account's computer", async () => {
    const room = await openRoom("Move");
    const skillsRoot = await mkdtemp(join(tmpdir(), "nano-adopt-"));
    const old = join(skillsRoot, "accounts", room.accountId);
    await mkdir(join(old, "ledger"), { recursive: true });
    const body = "---\nname: ledger\ndescription: Keeps the ledger.\n---\n\nAdd each line.\n";
    await writeFile(join(old, "ledger", "SKILL.md"), body);
    await adoptHostSkills(skillsRoot, room.accountId);
    expect((await exec(room.accountId, ["cat", "/shared/skills/ledger/SKILL.md"])).stdout).toBe(body);
    expect(existsSync(old)).toBe(false);
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("approves over HTTP for this account only, and a live turn does not edit the prompt", async () => {
    const room = await openRoom("Http");
    const message = await saveMessage(room, "Add a standing line.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "prompt",
      headers: { "content-type": "application/json" },
      body: "Sign every letter.",
      messageIds: [message.id],
    });
    const server = await startServer(db, 0, undefined, { openAccess: true });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const outsider = await createAccount(db, { name: "Outsider" });
    const blocked = await fetch(`${baseUrl}/proposals/${saved.id}/approve?accountId=${outsider.id}`, { method: "POST" });
    expect(blocked.status).toBe(404);
    expect(await promptVersion(room.agentId)).toBe(1);

    const approved = await fetch(`${baseUrl}/proposals/${saved.id}/approve?accountId=${room.accountId}`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(await promptVersion(room.agentId)).toBe(2);
    const [agent] = await db.select().from(agents).where(eq(agents.id, room.agentId));
    expect(agent?.jobDescription.endsWith("Sign every letter.")).toBe(true);
    await new Promise<void>((resolve, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolve()));
    });

    const before = await promptVersion(room.agentId);
    const [conversation] = await db
      .insert(conversations)
      .values({ accountId: room.accountId, kind: "direct", ownerAgentId: room.agentId, title: "live" })
      .returning();
    await runTurn(db, room.accountId, conversation!.id, "hello", async () => ({
      text: "noted",
      proposal: { kind: "prompt" as const, body: "Do not apply this yet.", messageIds: [message.id] },
    }));
    const [afterTurn] = await db.select().from(agents).where(eq(agents.id, room.agentId));
    expect(afterTurn?.promptVersion).toBe(before);
    expect(afterTurn?.jobDescription.includes("Do not apply this yet.")).toBe(false);
    const pending = await db.select().from(proposals).where(eq(proposals.agentId, room.agentId));
    expect(pending.some((row) => row.body === "Do not apply this yet." && row.status === "pending")).toBe(true);
  });
});

async function openRoom(name: string) {
  const account = await createAccount(db, { name });
  const owner = await createAgent(db, account.id, {
    name: "Ada",
    label: "Ada",
    role: "Ledger keeper",
    jobDescription: "Keep the ledger.",
    provider: "openai",
    modelId: "gpt-5",
  });
  return { accountId: account.id, agentId: owner.id };
}

async function saveMessage(room: { accountId: string; agentId: string }, body: string) {
  const [conversation] = await db
    .insert(conversations)
    .values({ accountId: room.accountId, kind: "direct", ownerAgentId: room.agentId, title: "note" })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({ accountId: room.accountId, conversationId: conversation!.id, agentId: null, body })
    .returning();
  return message!;
}

async function promptVersion(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  return agent?.promptVersion;
}
