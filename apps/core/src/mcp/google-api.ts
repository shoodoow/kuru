import type { getDb } from "../db/client.js";
import { forgetGoogleGrant, GoogleGrantRevokedError, googleAccessToken } from "./google-oauth.js";
import { googleRefreshToken } from "./plugins.js";
import { youtube } from "../social/youtube.js";

const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 30_000;
type Database = ReturnType<typeof getDb>;
type Args = Record<string, unknown>;
// Google's replies are read field by field; each use below names the fields it needs.
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON from Google's REST API
type Json = Record<string, any>;

/**
 * Runs one featured Google tool (Gmail, Calendar or Drive).
 * Why on the core: the access token is minted and used here, so no Google
 * token is ever written into the account's container where an agent could
 * read it. The login session is not used.
 * Input: database, account id, plugin slug, tool name and arguments.
 * Output: the result as JSON text, or a plain sentence when the call failed.
 */
export async function runGoogleTool(
  db: Database,
  accountId: string,
  slug: string,
  toolName: string,
  args: Args,
  /** The agent's Linux user, for tools that send a file from its computer (YouTube). */
  profile?: string | null,
): Promise<string> {
  const stored = await googleRefreshToken(db, accountId);
  if (!stored?.refreshToken) return "Connect this Google plugin again.";
  try {
    const token = await googleAccessToken(stored.refreshToken);
    let result: unknown;
    if (slug === "gmail") result = await gmail(toolName, args, token);
    else if (slug === "google-calendar") result = await calendar(toolName, args, token);
    else if (slug === "google-drive") result = await drive(toolName, args, token);
    else if (slug === "youtube") result = await youtube(toolName, args, token, { accountId, profile });
    else throw new Error(`Unknown Google plugin ${slug}.`);
    const text = JSON.stringify(result);
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
  } catch (error) {
    if (error instanceof GoogleGrantRevokedError) await forgetGoogleGrant(db, accountId).catch(() => undefined);
    return error instanceof Error ? error.message : "The Google call failed.";
  }
}

async function google(path: string, token: string, init: RequestInit = {}): Promise<Json> {
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 400) || `Google HTTP ${response.status}`);
  return text ? (JSON.parse(text) as Json) : {};
}

/** One header value on one line, so a recipient or subject cannot add headers of its own. */
function headerValue(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 8000 ? `${text.slice(0, 8000)}\n[truncated]` : text;
}

async function gmail(tool: string, args: Args, token: string): Promise<unknown> {
  if (tool === "search") {
    const listed = await google(`/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(String(args.query ?? ""))}`, token);
    const messages = [];
    for (const row of (listed.messages ?? []) as Json[]) {
      const full = await google(`/gmail/v1/users/me/messages/${row.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token);
      const headers = Object.fromEntries(((full.payload?.headers ?? []) as Json[]).map((header) => [header.name, header.value]));
      messages.push({ id: row.id, from: headers.From ?? "", subject: headers.Subject ?? "", snippet: full.snippet ?? "" });
    }
    return { messages };
  }
  if (tool === "read") {
    const full = await google(`/gmail/v1/users/me/messages/${encodeURIComponent(String(args.id ?? ""))}?format=full`, token);
    return { id: full.id, snippet: full.snippet ?? "", body: clip(plainPart(full.payload) || full.snippet || "") };
  }
  if (tool === "create_draft") {
    const raw = Buffer.from(`To: ${headerValue(args.to)}\r\nSubject: ${headerValue(args.subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString("base64url");
    const draft = await google("/gmail/v1/users/me/drafts", token, { method: "POST", body: JSON.stringify({ message: { raw } }) });
    return { id: draft.id, message: "Draft created. It was not sent." };
  }
  if (tool === "send") {
    if (args.draftId) {
      const sent = await google("/gmail/v1/users/me/drafts/send", token, {
        method: "POST",
        body: JSON.stringify({ id: String(args.draftId) }),
      });
      return { id: sent.id, message: "Sent." };
    }
    const raw = Buffer.from(`To: ${headerValue(args.to)}\r\nSubject: ${headerValue(args.subject)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`).toString("base64url");
    const sent = await google("/gmail/v1/users/me/messages/send", token, { method: "POST", body: JSON.stringify({ raw }) });
    return { id: sent.id, message: "Sent." };
  }
  if (tool === "archive") {
    const ids = messageIds(args);
    await google("/gmail/v1/users/me/messages/batchModify", token, { method: "POST", body: JSON.stringify({ ids, removeLabelIds: ["INBOX"] }) });
    return { archived: ids.length, message: "Archived. The messages are still in All Mail." };
  }
  if (tool === "delete") {
    const ids = messageIds(args);
    for (const id of ids) await google(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, token, { method: "POST" });
    return { trashed: ids.length, message: "Moved to Trash. Gmail empties Trash after 30 days." };
  }
  throw new Error(`Unknown Gmail tool ${tool}.`);
}

/** The message ids a tidy call names: `ids`, or a single `id`. At most 100, so one call cannot sweep a mailbox. */
function messageIds(args: Args): string[] {
  const raw = Array.isArray(args.ids) ? args.ids : args.id ? [args.id] : [];
  const ids = [...new Set(raw.map(String).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("Name at least one message id.");
  if (ids.length > 100) throw new Error("At most 100 messages per call.");
  return ids;
}

function plainPart(part: Json | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of (part.parts ?? []) as Json[]) {
    const text = plainPart(child);
    if (text) return text;
  }
  return "";
}

async function calendar(tool: string, args: Args, token: string): Promise<unknown> {
  if (tool === "search_events") {
    const params = new URLSearchParams({ maxResults: "10", singleEvents: "true", orderBy: "startTime" });
    if (args.query) params.set("q", String(args.query));
    if (args.timeMin) params.set("timeMin", String(args.timeMin));
    if (args.timeMax) params.set("timeMax", String(args.timeMax));
    if (!args.timeMin) params.set("timeMin", new Date().toISOString());
    const listed = await google(`/calendar/v3/calendars/primary/events?${params}`, token);
    return {
      events: ((listed.items ?? []) as Json[]).map((event) => ({
        id: event.id,
        summary: event.summary ?? "",
        start: event.start?.dateTime || event.start?.date || "",
        end: event.end?.dateTime || event.end?.date || "",
      })),
    };
  }
  if (tool === "create_event") {
    const created = await google("/calendar/v3/calendars/primary/events", token, {
      method: "POST",
      body: JSON.stringify({
        summary: args.summary,
        start: { dateTime: args.start },
        end: { dateTime: args.end },
      }),
    });
    return { id: created.id, summary: created.summary, htmlLink: created.htmlLink };
  }
  throw new Error(`Unknown Calendar tool ${tool}.`);
}

async function drive(tool: string, args: Args, token: string): Promise<unknown> {
  if (tool === "search") {
    const q = `name contains '${String(args.query ?? "").split("'").join("\\'")}'`;
    const listed = await google(`/drive/v3/files?pageSize=10&fields=files(id,name,mimeType)&q=${encodeURIComponent(q)}`, token);
    return { files: listed.files ?? [] };
  }
  if (tool === "read") {
    const fileId = encodeURIComponent(String(args.fileId ?? ""));
    const meta = await google(`/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink`, token);
    let text = "";
    if (String(meta.mimeType ?? "").startsWith("text/") || meta.mimeType === "application/json") {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = clip(await response.text());
    }
    return { ...meta, text };
  }
  throw new Error(`Unknown Drive tool ${tool}.`);
}
