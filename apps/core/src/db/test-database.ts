import postgres from "postgres";
import { migrateDb } from "./client.js";

/**
 * The database the test suite runs against.
 * Why: tests used to write accounts, chats and workers into the same database
 * the developer chats in. A separate database, created and migrated on first
 * use, keeps test rows out of real threads.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database_test";

/**
 * Creates the test database when it is missing and brings it up to date.
 * Input: none. Output: nothing. Safe to call on every run.
 */
export async function prepareTestDatabase(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("TEST_DATABASE_URL must name a database made of lowercase letters, digits and underscores.");
  }
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const existing = await sql`select 1 from pg_database where datname = ${name}`;
    if (existing.length === 0) {
      await sql.unsafe(`create database "${name}"`);
    }
  } finally {
    await sql.end();
  }
  await migrateDb(TEST_DATABASE_URL);
}
