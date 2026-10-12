/**
 * Files on an account's computer, as the social plugins need them.
 * Why: a video an agent made lives on that account's computer. YouTube and
 * TikTok take the bytes from this server, which reads them from the computer
 * as a stream so a 2 GB file never sits in memory. Instagram (and TikTok for
 * photos) will not take bytes at all: they download the file from a public
 * address, so this server hands out a short-lived signed link to that file.
 * Every read runs as the agent's own Linux user, inside its home or /shared,
 * so a tool cannot be talked into publishing a file the agent could not open.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { assertInside, expandHome } from "../computer/find.js";
import { execStream } from "../linux/linux.js";
import { fileSize } from "../rooms/uploads.js";

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  sbv: "text/plain",
};

export type ComputerFile = { accountId: string; profile: string; path: string; name: string; size: number; mime: string; extension: string };

/**
 * Finds one file an agent named and checks it can be read.
 * Input: account id, the agent's Linux user, and a path ("~/..." works).
 * Output: the file's facts. Throws a sentence the agent can act on.
 */
export async function computerFile(accountId: string, profile: string | null | undefined, rawPath: unknown): Promise<ComputerFile> {
  if (!profile) throw new Error("This agent has no computer yet, so there is no file to send.");
  if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("Give the file's path on your computer.");
  const path = expandHome(accountId, profile, rawPath);
  assertInside(accountId, profile, path);
  const size = await fileSize(accountId, path, profile);
  if (size === null) throw new Error(`No readable file at ${path}. Check the path with glob.`);
  if (size === 0) throw new Error(`The file at ${path} is empty.`);
  const name = path.split("/").pop() ?? "file";
  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return { accountId, profile, path, name, size, extension, mime: MIME[extension] ?? "application/octet-stream" };
}

/**
 * Opens part of a file as a stream.
 * Input: the file, the first byte (0-based) and how many bytes. Output: the stream and a way to stop it early.
 */
export async function openFile(file: ComputerFile, start = 0, length = file.size - start): Promise<{ stream: Readable; stop: () => void }> {
  const opened = await execStream(
    file.accountId,
    ["sh", "-c", 'tail -c "+$2" -- "$1" | head -c "$3"', "send", file.path, String(start + 1), String(length)],
    file.profile,
  );
  return { stream: opened.output, stop: opened.stop };
}

type LinkPayload = { a: string; u: string; p: string; e: number };

/** How long a platform has to fetch a file after it is handed the link. */
const LINK_TTL_SECONDS = 2 * 60 * 60;

/**
 * A public address for one file, good for two hours.
 * Why signed: the link is fetched by Instagram's or TikTok's servers, which
 * carry no session. The signature names the account, the Linux user and the
 * exact path, so the link opens that one file and nothing else.
 * Input: the file. Output: an https address under this server's public address.
 */
export function publicFileUrl(file: ComputerFile): string {
  const base = config.publicUrl().replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    throw new Error(
      `This platform downloads the file from this server, which needs a public https address. The server's address is ${base}. Set BETTER_AUTH_URL to the public https address (the tunnel) and try again.`,
    );
  }
  const payload = Buffer.from(
    JSON.stringify({ a: file.accountId, u: file.profile, p: file.path, e: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS } satisfies LinkPayload),
  ).toString("base64url");
  return `${base}/social/file/${payload}.${sign(payload)}/${encodeURIComponent(file.name)}`;
}

/** Opens a signed link. Output: who and what it names, or null when it is forged or out of date. */
export function readFileLink(token: string): { accountId: string; profile: string; path: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LinkPayload;
    if (typeof data.a !== "string" || typeof data.u !== "string" || typeof data.p !== "string" || typeof data.e !== "number") return null;
    if (data.e < Math.floor(Date.now() / 1000)) return null;
    return { accountId: data.a, profile: data.u, path: data.p };
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", `social-file:${config.authSecret()}`).update(payload).digest("base64url");
}
