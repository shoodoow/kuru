import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { acquireRun, failRun } from "../rooms/runs.js";
import { textOf } from "../rooms/turn.js";
import { startServer } from "./server.js";
import { toolApprovals } from "../db/schema.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);
const systemPrompt = readFileSync(new URL("../../../../prompts/system.md", import.meta.url), "utf8").trim();

describe("server", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const server = await startServer(db, 0, async ({ messages }) => {
      const mentionedBea = messages.some((message) => textOf(message.content).includes("@Bea"));
      return mentionedBea ? "finished" : "@Bea your turn";
    }, { openAccess: true });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  afterAll(async () => {
    await closeServer?.();
    await db.$client.end();
  });

  it("answers the local Expo web preflight", async () => {
    const response = await fetch(`${baseUrl}/api/auth/get-session`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:8081",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8081");
  });

  it("hires an agent, updates pin, and returns a prompt that starts with identity", async () => {
    const accountResponse = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Desk" }),
    });
    const account = (await accountResponse.json()) as { id: string };
    const agentResponse = await fetch(`${baseUrl}/accounts/${account.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        label: "Books",
        role: "Teammate",
        jobDescription: "Keep the ledger.",
        provider: "openai",
        modelId: "gpt-5",
      }),
    });
    const agent = (await agentResponse.json()) as { id: string; linuxProfile: string | null };
    expect(agent.linuxProfile).toBeNull();

    const patched = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notify: true, pinned: true, hidden: false }),
    });
    expect(await patched.json()).toMatchObject({ pinned: true });

    const marked = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markShape: "round", markColor: "#FF8066", markMaterial: "plush", avatarUrl: null }),
    });
    expect(await marked.json()).toMatchObject({
      markShape: "round",
      markColor: "#FF8066",
      markMaterial: "plush",
      avatarUrl: null,
    });

    const badMark = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markShape: "heptagon" }),
    });
    expect(badMark.status).toBe(400);

    const prompt = await fetch(`${baseUrl}/agents/${agent.id}/prompt?accountId=${account.id}`);
    const body = (await prompt.json()) as { prompt: string };
    expect(body.prompt.indexOf(systemPrompt)).toBe(0);
    expect(body.prompt.endsWith("Keep the ledger.")).toBe(true);

    const other = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other" }),
    });
    const second = (await other.json()) as { id: string };
    const hidden = await fetch(`${baseUrl}/agents/${agent.id}?accountId=${second.id}`);
    expect(hidden.status).toBe(404);
  });

  it("lists, pauses, and deletes one agent's routines over HTTP", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Routines" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const created = await postJson<{ id: string }>(
      `${baseUrl}/agents/${ada.id}/routines?accountId=${account.id}`,
      {
        conversationId: room.id,
        title: "License sale",
        instructions: "Sell the license",
        cron: "32 9 * * *",
        timezone: "UTC",
      },
    );
    expect(created.id).toBeTruthy();

    const listed = (await (
      await fetch(`${baseUrl}/agents/${ada.id}/routines?accountId=${account.id}`)
    ).json()) as { id: string; paused: boolean }[];
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    expect(listed[0]?.paused).toBe(false);

    const bad = await fetch(`${baseUrl}/agents/${ada.id}/routines?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: room.id, title: "Bad", instructions: "Bad", cron: "nonsense" }),
    });
    expect(bad.status).toBe(400);

    const paused = await fetch(`${baseUrl}/agents/${ada.id}/routines/${created.id}?accountId=${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(((await paused.json()) as { paused: boolean }).paused).toBe(true);

    const removed = await fetch(
      `${baseUrl}/agents/${ada.id}/routines/${created.id}?accountId=${account.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const empty = (await (
      await fetch(`${baseUrl}/agents/${ada.id}/routines?accountId=${account.id}`)
    ).json()) as unknown[];
    expect(empty).toEqual([]);

    const outsider = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Outsider" });
    const foreign = (await (
      await fetch(`${baseUrl}/agents/${ada.id}/routines?accountId=${outsider.id}`)
    ).json()) as unknown[];
    expect(foreign).toEqual([]);
    const blocked = await fetch(`${baseUrl}/agents/${ada.id}/routines?accountId=${outsider.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: room.id,
        title: "Nope",
        instructions: "Nope",
        cron: "0 9 * * *",
      }),
    });
    expect(blocked.status).toBe(404);
  });

  it("stores vault secrets write-only and rejects bad names", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Vault HTTP" });
    const secret = await postJson<{ name: string; configured: boolean }>(
      `${baseUrl}/accounts/${account.id}/secrets`,
      { name: "CMO_PASSWORD", secret: "s3cr3t" },
    );
    expect(secret).toEqual({ name: "CMO_PASSWORD", configured: true });
    const empty = await fetch(`${baseUrl}/accounts/${account.id}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CMO_PASSWORD", secret: "" }),
    });
    expect(empty.status).toBe(400);
    const badName = await fetch(`${baseUrl}/accounts/${account.id}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "has space", secret: "x" }),
    });
    expect(badName.status).toBe(400);
  });

  it("persists Auto-review and approves a pending tool row", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Review HTTP" });
    const settings = (await (await fetch(`${baseUrl}/accounts/${account.id}/settings`)).json()) as { autoReview: boolean };
    expect(settings.autoReview).toBe(true);
    const patched = await fetch(`${baseUrl}/accounts/${account.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoReview: false }),
    });
    expect(((await patched.json()) as { autoReview: boolean }).autoReview).toBe(false);

    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const [row] = await db
      .insert(toolApprovals)
      .values({
        accountId: account.id,
        agentId: ada.id,
        conversationId: room.id,
        tool: "bash",
        inputHash: "abc",
        summary: "rm -rf /tmp/x",
      })
      .returning();
    const listed = (await (
      await fetch(`${baseUrl}/accounts/${account.id}/tool-approvals`)
    ).json()) as { id: string; status: string }[];
    expect(listed.map((item) => item.id)).toEqual([row!.id]);
    const approved = await fetch(`${baseUrl}/accounts/${account.id}/tool-approvals/${row!.id}/approve`, {
      method: "POST",
    });
    expect(((await approved.json()) as { status: string }).status).toBe("approved");
    const empty = (await (await fetch(`${baseUrl}/accounts/${account.id}/tool-approvals`)).json()) as unknown[];
    expect(empty).toEqual([]);
  });

  it("stores a mentioned reply and the agent that reply mentions, in order", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Group" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const bea = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Bea"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id, bea.id],
    });
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&sync=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "@Ada start" }),
    });
    const stored = (await sent.json()) as { replies: { agentId: string; body: string }[] };
    expect(sent.status).toBe(201);
    // Bea names nobody, so the floor returns to Ada, who leads the room.
    expect(stored.replies.map((reply) => reply.agentId)).toEqual([ada.id, bea.id, ada.id]);
    expect(stored.replies.map((reply) => reply.body)).toEqual(["@Bea your turn", "finished", "finished"]);

    const other = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Outsider" });
    const blocked = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${other.id}&sync=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "@Ada start" }),
    });
    expect(blocked.status).toBe(404);
  });

  it("persists the user message before the background turn (never vanishes)", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Durable" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "check octessa.com SEO" }),
    });
    expect(sent.status).toBe(202);
    const accepted = (await sent.json()) as { message: { id: string; body: string } };
    expect(accepted.message.body).toBe("check octessa.com SEO");
    // The message is durable immediately — a refresh racing the turn finds it.
    const thread = (await (
      await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`)
    ).json()) as { id: string }[];
    expect(thread.map((row) => row.id)).toContain(accepted.message.id);
  });

  it("accepts multi-megabyte image attachments (no 413)", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Large" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const big = `data:image/png;base64,${"A".repeat(2_000_000)}`;
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ kind: "image", url: big, alt: "photo" }] }),
    });
    expect(sent.status).toBe(202);
    const accepted = (await sent.json()) as { message: { id: string } };
    expect(accepted.message.id).toBeDefined();
  });

  it("accepts uploads scoped under the account", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Uploads" });
    const accepted = await fetch(`${baseUrl}/accounts/${account.id}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://cdn.example/pic.png", name: "pic.png" }),
    });
    expect(accepted.status).toBe(201);
    const rejected = await fetch(`${baseUrl}/accounts/${account.id}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "data:application/x-sh;base64,AAAA" }),
    });
    expect(rejected.status).toBe(400);
  });

  it("serves stripped attachment bytes per block", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Blob" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "desk",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const big = `data:image/png;base64,${"B".repeat(300_000)}`;
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&sync=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ kind: "image", url: big, alt: "photo" }] }),
    });
    expect(sent.status).toBe(201);
    const thread = (await (
      await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`)
    ).json()) as { id: string; payload: { url?: string; blobRef?: { messageId: string; index: number } }[] }[];
    const userRow = thread.find((row) => row.payload?.[0]?.blobRef);
    expect(userRow?.payload[0]?.url).toBe("");
    const blob = (await (
      await fetch(
        `${baseUrl}/conversations/${room.id}/blob/${userRow!.id}/0?accountId=${account.id}`,
      )
    ).json()) as { url?: string };
    expect(blob.url).toBe(big);
    const missing = await fetch(`${baseUrl}/conversations/${room.id}/blob/${userRow!.id}/7?accountId=${account.id}`);
    expect(missing.status).toBe(404);
  });

  it("lists group members for the room header", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Members" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const bea = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Bea"));
    const room = await postJson<{ id: string; title: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "Launch",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id, bea.id],
    });
    expect(room.title).toBe("Launch");
    const members = (await (
      await fetch(`${baseUrl}/conversations/${room.id}/members?accountId=${account.id}`)
    ).json()) as { agentId: string }[];
    expect(members.map((member) => member.agentId).sort()).toEqual([ada.id, bea.id].sort());
    const outsider = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Stranger" });
    const blocked = await fetch(`${baseUrl}/conversations/${room.id}/members?accountId=${outsider.id}`);
    expect(blocked.status).toBe(404);
  });

  it("rejects a 21st member", async () => {    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Full" });
    const hired = [];
    for (let index = 0; index < 20; index += 1) {
      hired.push(await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent(`M${index}`)));
    }
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "group",
      title: "full",
      ownerAgentId: hired[0]!.id,
      memberAgentIds: hired.map((member) => member.id),
    });
    const extra = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Extra"));
    const rejected = await fetch(`${baseUrl}/conversations/${room.id}/members?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: extra.id }),
    });
    expect(rejected.status).toBe(409);
  }, 30_000);

  it("replays missed events by cursor on the stream", async () => {    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Resume" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "resume",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&sync=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(sent.status).toBe(201);
    // Full replay from zero carries the agent bubble with a cursor.
    const full = await readStream(`${baseUrl}/conversations/${room.id}/stream?accountId=${account.id}&cursor=0`, 2);
    const cursors = full.map((event) => event.cursor).filter((cursor): cursor is number => typeof cursor === "number");
    expect(cursors.length).toBeGreaterThan(0);
    const max = Math.max(...cursors);
    // Resume after the last cursor replays nothing further.
    const empty = await readStream(
      `${baseUrl}/conversations/${room.id}/stream?accountId=${account.id}&cursor=${max}`,
      0,
    );
    expect(empty).toHaveLength(0);
  }, 15000);

  it("registers push devices idempotently and lists pending pings", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Push" });
    const token = `ExponentPushToken[push-${Date.now()}]`;
    const first = await postJson<{ id: string }>(`${baseUrl}/devices?accountId=${account.id}`, {
      expoPushToken: token,
      platform: "ios",
    });
    expect(first.id).toBeDefined();
    const second = await postJson<{ id: string }>(`${baseUrl}/devices?accountId=${account.id}`, {
      expoPushToken: token,
      platform: "android",
    });
    expect(second.id).toBe(first.id);
    const bad = await fetch(`${baseUrl}/devices?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expoPushToken: "" }),
    });
    expect(bad.status).toBe(400);
    const pending = (await (
      await fetch(`${baseUrl}/notifications?accountId=${account.id}`)
    ).json()) as unknown[];
    expect(Array.isArray(pending)).toBe(true);
  });

  it("pages a thread from its newest messages backwards", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Pages" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "pages",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    for (const body of ["one", "two", "three"]) {
      await postJson(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&sync=1`, { body });
    }
    const list = async (query: string): Promise<{ id: string }[]> =>
      (await (await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}${query}`)).json()) as {
        id: string;
      }[];
    const all = await list("");
    expect(all.length).toBeGreaterThanOrEqual(6);
    const ids = all.map((row) => row.id);
    expect((await list("&limit=2")).map((row) => row.id)).toEqual(ids.slice(-2));
    expect((await list(`&limit=3&before=${ids.at(-2)}`)).map((row) => row.id)).toEqual(ids.slice(-5, -2));
    expect(await list(`&limit=3&before=${ids[0]}`)).toEqual([]);
    const bad = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}&before=nope`);
    expect(bad.status).toBe(400);
  });

  it("queues arrivals on a busy room instead of holding HTTP", async () => {
    const account = await postJson<{ id: string }>(`${baseUrl}/accounts`, { name: "Busy" });
    const ada = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/agents`, agent("Ada"));
    const room = await postJson<{ id: string }>(`${baseUrl}/accounts/${account.id}/conversations`, {
      kind: "direct",
      title: "busy",
      ownerAgentId: ada.id,
      memberAgentIds: [ada.id],
    });
    // Wedge the room with a running run, then POST without sync.
    const wedge = await acquireRun(db, account.id, room.id, "turn", 0);
    const sent = await fetch(`${baseUrl}/conversations/${room.id}/messages?accountId=${account.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "while busy" }),
    });
    expect(sent.status).toBe(202);
    const accepted = (await sent.json()) as { queued?: boolean; message: { id: string } };
    expect(accepted.queued).toBe(true);
    await failRun(db, wedge.id, "test released the wedge");
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

/**
 * Reads SSE data events until enough arrive or the timeout hits.
 * Why: the stream endpoint never closes on its own — read what the replay
 * delivers, then abort. Input: stream URL + wanted event count.
 * Output: parsed data payloads in arrival order.
 */
async function readStream(url: string, want: number): Promise<{ cursor?: number }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) return [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const out: { cursor?: number }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try {
            const payload = JSON.parse(line.slice(6)) as { cursor?: number; type?: string };
            // Skip the ready marker (no cursor, no type) — only real events count.
            if (payload && typeof payload === "object" && ("cursor" in payload || "type" in payload)) {
              out.push(payload);
            }
          } catch {
            // Keepalive or partial frame; ignore.
          }
          if (out.length >= want && want > 0) return out;
        }
        index = buffer.indexOf("\n\n");
      }
      if (want === 0) {
        // Give the replay one extra beat to (not) deliver, then stop.
        await new Promise((resolve) => setTimeout(resolve, 300));
        break;
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
