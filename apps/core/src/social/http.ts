/**
 * The few HTTP pieces the social plugins share.
 * Why not fetch for uploads: a platform wants an exact Content-Length on a
 * body that is a stream from the account's computer. Node's own request
 * object sends exactly the headers it is given and takes a stream as it comes.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

// Platform replies are read field by field; each use names the fields it needs.
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from a platform's REST API
export type Json = Record<string, any>;
export type Args = Record<string, unknown>;

const TIMEOUT_MS = 30_000;

export type Sent = { status: number; headers: Record<string, string>; text: string };

/**
 * Sends a stream as a request body with an exact length.
 * Input: method, address, headers (Content-Length among them) and the stream; null sends no body.
 * Output: the status, the reply's headers in lower case, and the reply text.
 */
export function sendStream(method: string, url: string, headers: Record<string, string>, body: Readable | null): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === "http:" ? httpRequest : httpsRequest)(target, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) flat[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
        resolve({ status: response.statusCode ?? 0, headers: flat, text: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    // No overall deadline: a large video takes as long as the line allows. A connection that goes silent is cut.
    request.setTimeout(5 * 60_000, () => request.destroy(new Error("The upload stopped moving for five minutes.")));
    if (!body) {
      request.end();
      return;
    }
    body.on("error", (error) => request.destroy(error));
    body.pipe(request);
  });
}

/**
 * One JSON call to a platform.
 * Input: address and fetch options. Output: the parsed reply. A refusal throws
 * the platform's own words, which is what the agent needs to fix the call.
 */
export async function callJson(url: string, init: RequestInit = {}): Promise<Json> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    if (response.ok) return { text };
  }
  if (!response.ok) throw new Error(platformError(body, text, response.status));
  return body;
}

/** The sentence a platform gave for a refusal, whichever shape it used. */
export function platformError(body: Json, text: string, status: number): string {
  const error = body.error;
  const message =
    (typeof error === "object" && error ? (error.message ?? error.error_user_msg ?? error.code) : error) ??
    body.error_description ??
    body.error_message ??
    body.message;
  return `${typeof message === "string" && message ? message : text.slice(0, 300) || "The platform refused the request"} (HTTP ${status})`;
}

/** Text arguments, trimmed; undefined when missing or blank. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A list of strings from an argument that may be a list or a comma-separated string. */
export function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

/** A whole number within bounds, or the fallback. */
export function count(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One upload per account and three on the whole server at a time, so a busy account cannot take the whole line. */
const active = new Set<string>();
const MAX_UPLOADS = 3;

export async function withUploadSlot<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  if (active.has(accountId)) throw new Error("Another upload from this account is still running. Wait for it to finish, then try again.");
  if (active.size >= MAX_UPLOADS) throw new Error("This server is already sending three uploads. Try again in a few minutes.");
  active.add(accountId);
  try {
    return await work();
  } finally {
    active.delete(accountId);
  }
}
