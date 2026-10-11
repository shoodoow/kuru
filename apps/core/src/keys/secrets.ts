import { secretInputSchema } from "@kuru/shared";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { accountSecrets } from "../db/schema.js";
import { open, seal } from "./keys.js";

/**
 * Saves one vault secret for one account (upsert, sealed).
 * Why: secret widgets collect passwords/tokens that must never appear in
 * chat — the sealed value is write-only over HTTP, so the asking bot can
 * never read it back. Blank secrets never wipe a stored value.
 * Input: db, account id, {name, secret}. Output: the name + configured flag.
 */
export async function saveSecret(
  db: Store,
  accountId: string,
  input: { name: string; secret: string },
): Promise<{ name: string; configured: boolean }> {
  const data = secretInputSchema.parse(input);
  if (!data.secret.trim()) {
    throw new Error("The secret is required.");
  }
  const sealed = seal(data.secret);
  const [existing] = await db
    .select({ name: accountSecrets.name })
    .from(accountSecrets)
    .where(and(eq(accountSecrets.accountId, accountId), eq(accountSecrets.name, data.name)))
    .limit(1);
  if (existing) {
    await db
      .update(accountSecrets)
      .set({ secret: sealed, updatedAt: new Date() })
      .where(and(eq(accountSecrets.accountId, accountId), eq(accountSecrets.name, data.name)));
  } else {
    await db.insert(accountSecrets).values({ accountId, name: data.name, secret: sealed });
  }
  return { name: data.name, configured: true };
}

/**
 * Reads one vault secret for server-side use (env injection, tool calls).
 * Why: only code paths — never HTTP, never chat — may open a sealed value.
 * Input: db, account id, secret name. Output: the plain secret, or throws.
 */
export async function secretFor(db: Store, accountId: string, name: string): Promise<string> {
  const [row] = await db
    .select({ secret: accountSecrets.secret })
    .from(accountSecrets)
    .where(and(eq(accountSecrets.accountId, accountId), eq(accountSecrets.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`No secret named "${name}" on this account.`);
  }
  return open(row.secret);
}
