import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { accounts, accountSecrets } from "../db/schema.js";
import { saveSecret, secretFor } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

afterAll(async () => {
  await db.$client.end();
});

test("vault secrets seal at rest, scope to the account, and upsert by name", async () => {
  const [first, second] = await db.insert(accounts).values([{ name: "Vault One" }, { name: "Vault Two" }]).returning();
  await expect(saveSecret(db, first!.id, { name: "CMO_PASSWORD", secret: "s3cr3t" })).resolves.toEqual({
    name: "CMO_PASSWORD",
    configured: true,
  });
  const [row] = await db
    .select({ secret: accountSecrets.secret })
    .from(accountSecrets)
    .where(eq(accountSecrets.accountId, first!.id));
  expect(row!.secret).not.toContain("s3cr3t");
  await expect(secretFor(db, first!.id, "CMO_PASSWORD")).resolves.toBe("s3cr3t");
  await expect(secretFor(db, second!.id, "CMO_PASSWORD")).rejects.toThrow(/No secret/);
  await saveSecret(db, first!.id, { name: "CMO_PASSWORD", secret: "r0tated" });
  await expect(secretFor(db, first!.id, "CMO_PASSWORD")).resolves.toBe("r0tated");
  await expect(saveSecret(db, first!.id, { name: "no spaces", secret: "x" })).rejects.toThrow(/ENV_VAR/);
  await expect(saveSecret(db, first!.id, { name: "EMPTY_OK", secret: "   " })).rejects.toThrow(/required/);
  await db.delete(accountSecrets).where(eq(accountSecrets.accountId, first!.id));
  await db.delete(accounts).where(eq(accounts.id, first!.id));
  await db.delete(accounts).where(eq(accounts.id, second!.id));
});
