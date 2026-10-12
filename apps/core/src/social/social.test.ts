import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The file's bytes come from memory here, not from an account's computer.
const bytes = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));
vi.mock("./files.js", async (original) => ({
  ...(await original<typeof import("./files.js")>()),
  openFile: vi.fn(async (_file: unknown, start = 0, length = bytes.length - start) => ({
    stream: Readable.from([bytes.subarray(start, start + length)]),
    stop: () => {},
  })),
}));

import { PLUGIN_CATALOG } from "../mcp/catalog.js";
import { classifyRisk } from "../turn/auto-review.js";
import { publicFileUrl, readFileLink, type ComputerFile } from "./files.js";
import { chunkPlan } from "./tiktok.js";
import { resumableUpload } from "./youtube.js";

const MB = 1024 * 1024;
const file: ComputerFile = { accountId: "11111111-1111-4111-8111-111111111111", profile: "uabc", path: "/home/uabc/out/reel.mp4", name: "reel.mp4", size: bytes.length, mime: "video/mp4", extension: "mp4" };

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("signed file links", () => {
  it("opens the one file it was made for and nothing else", () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    const url = publicFileUrl(file);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/social\/file\/.+\/reel\.mp4$/);
    const token = url.split("/social/file/")[1]!.split("/")[0]!;
    expect(readFileLink(token)).toEqual({ accountId: file.accountId, profile: "uabc", path: file.path });
    // A link pointed at another path, or with a changed signature, opens nothing.
    const forged = Buffer.from(JSON.stringify({ a: file.accountId, u: "uabc", p: "/etc/passwd", e: 9_999_999_999 })).toString("base64url");
    expect(readFileLink(`${forged}.${token.split(".")[1]}`)).toBeNull();
    expect(readFileLink(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it("refuses to make a link a platform could not reach", () => {
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
    expect(() => publicFileUrl(file)).toThrow(/public https address/);
    process.env.BETTER_AUTH_URL = "https://api.example.com";
  });
});

describe("TikTok chunks", () => {
  it("sends a small file whole and splits a large one by TikTok's rules", () => {
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, chunks: [{ start: 0, length: 3 * MB }] });
    expect(chunkPlan(64 * MB).chunks).toHaveLength(1);
    const size = 200 * MB + 123;
    const plan = chunkPlan(size);
    // The count is the size over the chunk size, rounded down; the last chunk carries the remainder.
    expect(plan.chunks).toHaveLength(Math.floor(size / plan.chunkSize));
    expect(plan.chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(size);
    expect(plan.chunks.every((chunk, index) => chunk.start === index * plan.chunkSize)).toBe(true);
    expect(plan.chunkSize).toBeGreaterThanOrEqual(5 * MB);
    expect(plan.chunks.at(-1)!.length).toBeLessThanOrEqual(128 * MB);
    expect(chunkPlan(4 * 1024 * MB).chunks.length).toBeLessThanOrEqual(1000);
  });
});

describe("YouTube resumable upload", () => {
  let server: Server;
  let base = "";
  const received: Buffer[] = [];
  const seen: string[] = [];
  let firstTry = true;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const sent = await body(request);
      if (request.method === "POST") {
        seen.push(`start length=${request.headers["x-upload-content-length"]} type=${request.headers["x-upload-content-type"]} body=${sent.toString()}`);
        response.writeHead(200, { location: `${base}/session` }).end();
        return;
      }
      const range = String(request.headers["content-range"] ?? "");
      if (range.startsWith("bytes */")) {
        seen.push("status");
        const have = Buffer.concat(received).length;
        response.writeHead(308, have > 0 ? { range: `bytes=0-${have - 1}` } : {}).end();
        return;
      }
      if (firstTry) {
        // The connection "drops" after 2000 bytes arrived.
        firstTry = false;
        received.push(sent.subarray(0, 2000));
        seen.push("upload interrupted");
        response.writeHead(503).end();
        return;
      }
      seen.push(`upload ${range}`);
      received.push(sent);
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "vid123", snippet: { title: "Hello" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("carries on from the byte the server last received", async () => {
    const video = await resumableUpload(`${base}/videos?uploadType=resumable&part=snippet`, "token", { snippet: { title: "Hello" } }, file);
    expect(video.id).toBe("vid123");
    expect(seen[0]).toBe(`start length=5000 type=video/mp4 body={"snippet":{"title":"Hello"}}`);
    expect(seen.slice(1)).toEqual(["upload interrupted", "status", "upload bytes 2000-4999/5000"]);
    // Every byte arrived once, in order.
    expect(Buffer.concat(received).equals(bytes)).toBe(true);
  }, 20_000);
});

describe("social plugins in the catalog", () => {
  const social = PLUGIN_CATALOG.filter((plugin) => ["youtube", "instagram", "tiktok"].includes(plugin.id));

  it("offers the three platforms with names a model provider accepts", () => {
    expect(social.map((plugin) => plugin.id)).toEqual(["youtube", "instagram", "tiktok"]);
    for (const plugin of social) {
      const names = plugin.tools.map((entry) => `${plugin.id}_${entry.name}`);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      for (const entry of plugin.tools) expect(entry.description.length).toBeGreaterThan(10);
    }
  });

  it("lets every Instagram and TikTok tool name which signed-in account to use", () => {
    for (const plugin of social.filter((row) => row.provider !== "google")) {
      for (const entry of plugin.tools) {
        expect((entry.inputSchema as { properties: Record<string, unknown> }).properties.account).toBeDefined();
      }
    }
  });
});

describe("approval before publishing", () => {
  it("asks for a post, a delete or a public reply, and not for reading", () => {
    expect(classifyRisk("youtube_upload_video", { title: "Launch day", privacy: "public", path: "/home/u/a.mp4" })).toBe("Upload to YouTube (public): Launch day");
    expect(classifyRisk("instagram_publish_reel", { caption: "New drop", account: "@brand" })).toBe("Publish a reel on Instagram (as @brand): New drop");
    expect(classifyRisk("tiktok_post_video", { path: "/shared/clip.mp4" })).toBe("Post a video on TikTok: /shared/clip.mp4");
    expect(classifyRisk("youtube_delete_video", { id: "abc" })).toMatch(/Delete a YouTube video/);
    expect(classifyRisk("youtube_list_videos", {})).toBeNull();
    expect(classifyRisk("instagram_media_insights", { mediaId: "1" })).toBeNull();
  });
});
