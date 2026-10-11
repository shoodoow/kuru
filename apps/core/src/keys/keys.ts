import { ProviderCheckError, type ProviderCheck } from "./check-provider.js";
import { config } from "../config.js";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { providerKeySchema } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { providerKeys } from "../db/schema.js";

type Database = ReturnType<typeof getDb>;

export type StoredKey = { provider: string; baseUrl: string | null; configured: boolean };

/**
 * Lists the providers this account has saved.
 * Input: a database client and the account id.
 * Output: the provider names and local base URLs. The secret is never included.
 */
export async function listProviderKeys(db: Database, accountId: string): Promise<StoredKey[]> {
  const rows = await db
    .select({ provider: providerKeys.provider, baseUrl: providerKeys.baseUrl, secret: providerKeys.secret })
    .from(providerKeys)
    .where(eq(providerKeys.accountId, accountId));
  return rows.map((row) => ({
    provider: row.provider,
    baseUrl: row.baseUrl,
    configured: open(row.secret).length > 0 || row.provider === "local",
  }));
}

/**
 * Saves one provider secret for one account.
 * Input: a database client, the account id, and the provider, secret, and optional base URL.
 * Output: the saved provider without the secret. A blank secret keeps the previous secret.
 */
export async function saveProviderKey(
  db: Database,
  accountId: string,
  input: unknown,
  /** Asks the provider whether the key and address work. Left out, nothing is checked. */
  check?: (provider: string, apiKey: string, baseUrl: string | null) => Promise<ProviderCheck>,
): Promise<StoredKey & { note?: string }> {
  const data = providerKeySchema.parse(input);
  const [existing] = await db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.accountId, accountId), eq(providerKeys.provider, data.provider)));
  const plain = data.secret.trim() || (existing ? open(existing.secret) : "");
  const baseUrl = data.baseUrl !== undefined ? (data.baseUrl ?? null) : (existing?.baseUrl ?? null);
  if (baseUrl) {
    assertSafeProviderUrl(baseUrl);
  }
  // A key or address that does not work is refused here, not saved to fail later in a chat.
  const checked = check ? await check(data.provider, plain, baseUrl) : undefined;
  if (checked?.ok === false) throw new ProviderCheckError(checked.error);
  const secret = seal(plain);
  if (existing) {
    await db
      .update(providerKeys)
      .set({ secret, baseUrl })
      .where(and(eq(providerKeys.accountId, accountId), eq(providerKeys.provider, data.provider)));
  } else {
    await db.insert(providerKeys).values({ accountId, provider: data.provider, secret, baseUrl });
  }
  return {
    provider: data.provider,
    baseUrl,
    configured: plain.length > 0 || data.provider === "local",
    ...(checked?.ok === null ? { note: checked.note } : {}),
  };
}

function assertSafeProviderUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("The provider URL cannot contain credentials.");
  }
  if (config.isProduction() && url.protocol !== "https:") {
    throw new Error("A production provider URL must use HTTPS.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The provider URL must use HTTP or HTTPS.");
  }
}

/**
 * Reads the secret the model call should use.
 * Input: a database client, the account id, and the provider name.
 * Output: the API key and optional OpenAI-compatible base URL. Another account's key is not returned.
 */
export async function keyFor(db: Database, accountId: string, provider: string): Promise<{ apiKey: string; baseUrl: string | null }> {
  const [row] = await db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.accountId, accountId), eq(providerKeys.provider, provider)));
  if (!row) {
    throw new Error(`Add an API key for ${provider}.`);
  }
  return { apiKey: open(row.secret), baseUrl: row.baseUrl };
}

/**
 * Encrypts a provider secret.
 * Input: the plain secret.
 * Output: an iv, tag, and ciphertext that only this process secret can open.
 */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

/**
 * Decrypts a provider secret.
 * Input: the stored seal.
 * Output: the plain secret.
 */
export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) {
    throw new Error("The stored key is unreadable.");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

let derived: { secret: string; key: Buffer } | undefined;

/**
 * The vault key, derived once per secret.
 * Why: scrypt is slow on purpose and runs on the main thread, and this used to
 * run on every seal and open, so each model call stalled the whole server.
 */
function keyMaterial(): Buffer {
  const secret = config.authSecret();
  if (derived?.secret !== secret) {
    derived = { secret, key: scryptSync(secret, "nano-provider-keys", 32) };
  }
  return derived.key;
}

/**
 * A signing key for one purpose, derived from the auth secret.
 * Why: sessions, the vault and short-lived tokens must not share one raw key.
 * Input: a fixed label naming the purpose. Output: 32 key bytes.
 */
export function signingKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", config.authSecret(), "", purpose, 32));
}
