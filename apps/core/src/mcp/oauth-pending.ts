import { config } from "../config.js";
import { createHash, randomBytes } from "node:crypto";

export type PendingOAuth = {
  accountId: string;
  kind: "google" | "mcp" | "instagram" | "tiktok";
  pluginId?: string;
  slug?: string;
  url?: string;
  verifier: string;
  scopes: string[];
  tokenEndpoint?: string;
  clientId?: string;
  expires: number;
};

const pending = new Map<string, PendingOAuth>();

export function codeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Remembers one in-flight consent. The browser comes back with this id, not with the account id. */
export function savePending(record: Omit<PendingOAuth, "expires">): string {
  const now = Date.now();
  for (const [id, row] of pending) {
    if (row.expires < now) pending.delete(id);
  }
  const id = randomBytes(24).toString("base64url");
  pending.set(id, { ...record, expires: now + 10 * 60 * 1000 });
  return id;
}

export function peekPending(id: string): PendingOAuth | null {
  const row = pending.get(id);
  if (!row || row.expires < Date.now()) return null;
  return row;
}

export function takePending(id: string): PendingOAuth | null {
  const row = pending.get(id);
  pending.delete(id);
  if (!row || row.expires < Date.now()) return null;
  return row;
}

export function pluginCallbackUrl(): string {
  return `${config.publicUrl().replace(/\/$/, "")}/plugins/oauth/callback`;
}
