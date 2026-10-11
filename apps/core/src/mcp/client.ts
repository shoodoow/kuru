import { createHash } from "node:crypto";
import { createPublicFetch } from "../net/public-fetch.js";
import type { McpToolCacheEntry } from "./types.js";
import { assertSafeMcpUrl } from "./url.js";

type FetchImpl = typeof fetch;
type Message = Record<string, unknown>;
type Session = { id: string | undefined; version: string };

/** A tool call may wait on a slow remote service, so it gets longer than a page fetch. */
const mcpFetch = createPublicFetch({ timeoutMs: 120_000, maxBodyBytes: 5_000_000 });

/**
 * The newest protocol revision this client speaks. The server answers with the
 * one it will use (this or an older one), and that goes on every later request.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Most pages of tools read from one server, so a looping cursor cannot hold a turn. */
const MAX_TOOL_PAGES = 20;

/** The server answered with a failure status; `status` lets a caller tell a lost session from a real fault. */
export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** The server refused the token. The caller may refresh it and try once more. */
export class McpAuthError extends Error {
  constructor(message = "The MCP server refused the sign-in.") {
    super(message);
    this.name = "McpAuthError";
  }
}

/**
 * Lists the tools one MCP server offers.
 * Why here and not in the account's container: the bearer token then never
 * leaves the core, so an agent cannot read it and send it elsewhere. The
 * request can only reach a public address.
 * Input: the server URL and its bearer token (empty for an open server).
 * Output: every tool, across all pages. Throws when the server cannot be reached or refuses.
 */
export async function listMcpTools(url: string, bearer: string, fetchImpl: FetchImpl = mcpFetch): Promise<McpToolCacheEntry[]> {
  return withSession(url, bearer, fetchImpl, async (session) => {
    const tools: McpToolCacheEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listed = (await rpc(fetchImpl, url, bearer, session, "tools/list", cursor ? { cursor } : {})) as {
        tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
        nextCursor?: unknown;
      };
      for (const tool of listed.tools ?? []) {
        if (typeof tool.name !== "string" || !tool.name) continue;
        tools.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema });
      }
      cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  });
}

/**
 * Calls one tool on an MCP server.
 * Input: the server URL, its bearer token, the tool name and its arguments.
 * Output: the server's result object. Throws when the server cannot be reached or refuses.
 */
export async function callMcpTool(
  url: string,
  bearer: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: FetchImpl = mcpFetch,
): Promise<unknown> {
  return withSession(url, bearer, fetchImpl, (session) => rpc(fetchImpl, url, bearer, session, "tools/call", { name: toolName, arguments: args }));
}

/** How long an unused session is kept before the server is told it is over. */
const SESSION_IDLE_MS = 5 * 60 * 1000;
type Kept = { session: Session; usedAt: number; url: string; bearer: string };
// Kept per fetch implementation, so the real client and a test's stand-in never share a session.
const sessions = new WeakMap<FetchImpl, Map<string, Kept>>();

/**
 * Runs requests inside a session, reusing the one already open with this server.
 * Why: opening a session costs two round trips, and an agent often makes
 * several calls to the same server in one turn. A session the server has
 * forgotten (it answers 404) is opened again and the request repeated once.
 */
async function withSession<T>(url: string, bearer: string, fetchImpl: FetchImpl, run: (session: Session) => Promise<T>): Promise<T> {
  let kept = sessions.get(fetchImpl);
  if (!kept) sessions.set(fetchImpl, (kept = new Map()));
  const now = Date.now();
  for (const [key, entry] of kept) {
    if (now - entry.usedAt > SESSION_IDLE_MS) {
      kept.delete(key);
      closeSession(entry.url, entry.bearer, entry.session, fetchImpl);
    }
  }
  const key = createHash("sha256").update(`${url}\n${bearer}`).digest("hex");
  const known = kept.get(key);
  if (known) {
    known.usedAt = now;
    try {
      return await run(known.session);
    } catch (error) {
      if (!(error instanceof McpHttpError) || error.status !== 404) throw error;
      kept.delete(key);
    }
  }
  const session = await openSession(url, bearer, fetchImpl);
  // Only a server that hands out session ids has anything to reuse.
  if (session.id) kept.set(key, { session, usedAt: Date.now(), url, bearer });
  return run(session);
}

/**
 * Turns a tool result into the text an agent reads.
 * Why: a result is a list of content parts plus an error flag. Handed over as
 * raw JSON, a failure looked like a success and a picture arrived as a wall of
 * base64. Text parts are joined, other parts are named, and a failure says so.
 * Input: what `callMcpTool` returned. Output: the text and whether the tool failed.
 */
export function toolResultText(result: unknown): { text: string; failed: boolean } {
  const record = (typeof result === "object" && result !== null ? result : {}) as Message;
  const parts = Array.isArray(record.content) ? (record.content as Message[]) : [];
  const lines = parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "resource") {
        const resource = (part.resource ?? {}) as Message;
        return typeof resource.text === "string" ? resource.text : `[file ${String(resource.uri ?? "")} was returned and is not shown]`;
      }
      if (part.type === "resource_link") return `[link: ${String(part.uri ?? "")}]`;
      if (part.type === "image" || part.type === "audio") return `[${part.type} (${String(part.mimeType ?? "unknown type")}) was returned and is not shown]`;
      return "";
    })
    .filter(Boolean);
  // A server may answer with structured data only, or with something that is not a tool result at all.
  if (lines.length === 0) {
    const fallback = record.structuredContent ?? (Array.isArray(record.content) ? undefined : result);
    if (fallback !== undefined) lines.push(typeof fallback === "string" ? fallback : JSON.stringify(fallback));
  }
  const failed = record.isError === true;
  const text = lines.join("\n") || (failed ? "No details were given." : "Done. The tool returned nothing.");
  return { text: failed ? `The tool reported an error: ${text}` : text, failed };
}

function headers(bearer: string, session: Session | undefined): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer) out.authorization = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`;
  if (session?.id) out["mcp-session-id"] = session.id;
  if (session) out["mcp-protocol-version"] = session.version;
  return out;
}

let nextId = 1;

/**
 * Reads every JSON-RPC message out of an answer.
 * The answer is one JSON message (or a batch), or an event stream in which a
 * message may span several `data:` lines and other messages may come first.
 */
function messagesIn(text: string, contentType: string): Message[] {
  const parse = (raw: string): Message[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((entry): entry is Message => typeof entry === "object" && entry !== null);
    } catch {
      return [];
    }
  };
  if (!contentType.includes("text/event-stream") && !/^\s*(event|data|id|retry):/m.test(text.slice(0, 200))) return parse(text);
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n"),
    )
    .filter(Boolean)
    .flatMap(parse);
}

/**
 * Sends one request and returns its result.
 * Input: the method and params. Output: the `result` of the answer that
 * carries this request's id. Throws the server's own error, or McpAuthError on a 401.
 */
async function rpc(
  fetchImpl: FetchImpl,
  url: string,
  bearer: string,
  session: Session | undefined,
  method: string,
  params: unknown,
  onResponse?: (response: Response) => void,
): Promise<unknown> {
  assertSafeMcpUrl(url);
  const id = nextId++;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: headers(bearer, session),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  const messages = messagesIn(text, response.headers.get("content-type") ?? "");
  // Progress notes and the server's own requests can share the stream; only the answer to this request counts.
  const answer = messages.find((message) => message.id === id && ("result" in message || "error" in message)) ?? messages.find((message) => "error" in message && message.id == null);
  const failure = (answer?.error ?? undefined) as { message?: unknown } | undefined;
  if (response.status === 401) throw new McpAuthError(typeof failure?.message === "string" ? failure.message : undefined);
  if (!response.ok) {
    throw new McpHttpError((typeof failure?.message === "string" && failure.message) || text.slice(0, 500) || `MCP HTTP ${response.status}`, response.status);
  }
  if (failure) throw new Error(typeof failure.message === "string" && failure.message ? failure.message : "The MCP server returned an error.");
  if (!answer) throw new Error("The MCP server did not answer the request.");
  onResponse?.(response);
  return answer.result;
}

async function openSession(url: string, bearer: string, fetchImpl: FetchImpl): Promise<Session> {
  let id: string | undefined;
  const result = (await rpc(
    fetchImpl,
    url,
    bearer,
    undefined,
    "initialize",
    { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nano-agents", version: "0" } },
    (response) => {
      id = response.headers.get("mcp-session-id") || undefined;
    },
  )) as { protocolVersion?: unknown } | undefined;
  const session: Session = { id, version: typeof result?.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION };
  // The server does not answer this notice, and some servers reject it; the session works either way.
  await fetchImpl(url, {
    method: "POST",
    headers: headers(bearer, session),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined);
  return session;
}

/** Tells the server a session is over once it has sat unused. Nothing waits on it. */
function closeSession(url: string, bearer: string, session: Session, fetchImpl: FetchImpl): void {
  if (!session.id) return;
  void fetchImpl(url, { method: "DELETE", headers: headers(bearer, session) }).catch(() => undefined);
}
