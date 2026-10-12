import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { accounts, providerKeys } from "../db/schema.js";
import { keyFor, listProviderKeys, open, saveProviderKey, seal } from "./keys.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

afterAll(async () => {
  await db.$client.end();
});

test("a saved provider secret can be opened and is not stored in plain text", () => {
  const sealed = seal("sk-test");
  expect(sealed).not.toContain("sk-test");
  expect(open(sealed)).toBe("sk-test");
});

test("provider keys stay scoped to their account and are never listed", async () => {
  const [first, second] = await db.insert(accounts).values([{ name: "Keys One" }, { name: "Keys Two" }]).returning();
  await saveProviderKey(db, first!.id, { provider: "openai", secret: "sk-private", baseUrl: null });
  await expect(keyFor(db, first!.id, "openai")).resolves.toEqual({ apiKey: "sk-private", baseUrl: null });
  await expect(keyFor(db, second!.id, "openai")).rejects.toThrow(/Add an API key/);
  expect(await listProviderKeys(db, first!.id)).toEqual([
    { provider: "openai", baseUrl: null, configured: true },
  ]);
  await db.delete(providerKeys).where(eq(providerKeys.accountId, first!.id));
  await db.delete(accounts).where(eq(accounts.id, first!.id));
  await db.delete(accounts).where(eq(accounts.id, second!.id));
});

test("openai keys can store an OpenAI-compatible base URL", async () => {
  const [account] = await db.insert(accounts).values({ name: "NVIDIA Keys" }).returning();
  const nvidiaBase = "https://integrate.api.nvidia.com/v1";
  await saveProviderKey(db, account!.id, {
    provider: "openai",
    secret: "nvapi-test",
    baseUrl: nvidiaBase,
  });
  await expect(keyFor(db, account!.id, "openai")).resolves.toEqual({
    apiKey: "nvapi-test",
    baseUrl: nvidiaBase,
  });
  await db.delete(providerKeys).where(eq(providerKeys.accountId, account!.id));
  await db.delete(accounts).where(eq(accounts.id, account!.id));
});
