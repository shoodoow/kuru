import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { listAccountPlugins } from "../mcp/plugins.js";
import { deleteMcpServer } from "../mcp/store.js";
import { createAccount } from "../roster/roster.js";
import { saveSocialAccount, socialAccessToken, type StoredToken } from "./accounts.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

function token(userId: string, username: string): StoredToken {
  const now = Date.now();
  // Fresh enough that nothing is renewed, so no platform is called.
  return { accessToken: `token-${username}`, refreshToken: `refresh-${username}`, expiresAt: now + 50 * 24 * 3600 * 1000, issuedAt: now, userId, username };
}

describe("several accounts in one social plugin", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("keeps each signed-in account and asks which one when it is not said", async () => {
    const account = await createAccount(db, { name: "Agency" });
    const instagram = catalogPlugin("instagram")!;
    await saveSocialAccount(db, account.id, instagram, token("1", "brand_one"));
    // One account: no need to name it.
    expect((await socialAccessToken(db, account.id, "instagram")).token).toBe("token-brand_one");

    await saveSocialAccount(db, account.id, instagram, token("2", "brand_two"));
    await expect(socialAccessToken(db, account.id, "instagram")).rejects.toThrow(/Several Instagram accounts are connected: @brand_one, @brand_two/);
    expect((await socialAccessToken(db, account.id, "instagram", "@Brand_Two")).token).toBe("token-brand_two");
    await expect(socialAccessToken(db, account.id, "instagram", "nobody")).rejects.toThrow(/No Instagram account named nobody/);

    // Signing in again as the same account replaces its token and adds nothing.
    await saveSocialAccount(db, account.id, instagram, { ...token("1", "brand_one"), accessToken: "token-renewed" });
    expect((await socialAccessToken(db, account.id, "instagram", "brand_one")).token).toBe("token-renewed");

    const card = (await listAccountPlugins(db, account.id)).plugins.find((plugin) => plugin.id === "instagram");
    expect(card).toMatchObject({ installed: true, configured: true, multiAccount: true, accounts: ["@brand_two", "@brand_one"] });
    // The card never carries a token.
    expect(JSON.stringify(card)).not.toContain("token-");

    await deleteMcpServer(db, account.id, "instagram");
    await expect(socialAccessToken(db, account.id, "instagram")).rejects.toThrow(/Connect the Instagram plugin again/);
  });

  it("keeps one account's sign-ins away from another", async () => {
    const first = await createAccount(db, { name: "First" });
    const second = await createAccount(db, { name: "Second" });
    await saveSocialAccount(db, first.id, catalogPlugin("tiktok")!, token("9", "first_tiktok"));
    await expect(socialAccessToken(db, second.id, "tiktok")).rejects.toThrow(/Connect the TikTok plugin again/);
    expect((await listAccountPlugins(db, second.id)).plugins.find((plugin) => plugin.id === "tiktok")?.installed).toBe(false);
  });
});
