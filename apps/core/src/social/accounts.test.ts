import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { listAccountPlugins } from "../mcp/plugins.js";
import { peekPending } from "../mcp/oauth-pending.js";
import { createAccount } from "../roster/roster.js";
import { and, eq } from "drizzle-orm";
import { mcpServers } from "../db/schema.js";
import { saveSecret, takeSecret } from "../keys/secrets.js";
import { removeSocialAccounts, saveSocialAccount, socialAccessToken, socialUsableBy, startSocialOAuth, type StoredToken } from "./accounts.js";
import { connectSocial } from "./connect.js";

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

    // Instagram is handled by an agent in chat: the Plugins page neither lists it nor counts it.
    const page = await listAccountPlugins(db, account.id);
    expect(page.plugins.find((plugin) => plugin.id === "instagram")).toBeUndefined();
    expect(page.plugins.find((plugin) => plugin.id === "youtube")).toMatchObject({ installed: false, kind: "google" });
    expect(JSON.stringify(page)).not.toContain("token-");

    // Signing one out leaves the other; signing the last one out removes the row.
    expect(await removeSocialAccounts(db, account.id, "instagram", undefined, "brand_one")).toEqual(["@brand_one"]);
    expect((await socialAccessToken(db, account.id, "instagram")).token).toBe("token-brand_two");
    expect(await removeSocialAccounts(db, account.id, "instagram")).toEqual(["@brand_two"]);
    await expect(socialAccessToken(db, account.id, "instagram")).rejects.toThrow(/No Instagram account is connected for you/);
  });

  it("connects one agent from its chat, and keeps that connection from the other agents", async () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    const account = await createAccount(db, { name: "Two brands" });
    const anna = "aaaaaaaa-1111-4111-8111-111111111111";
    const ben = "bbbbbbbb-2222-4222-8222-222222222222";
    const said: string[] = [];
    // Everything the agent is told, with the message for the person taken out as the tool does.
    const call = async (agentId: string, input: Record<string, unknown>) => {
      const { show, ...told } = await connectSocial(db, account.id, agentId, input);
      said.push(JSON.stringify(told));
      return { told, show: (show ?? []) as { kind: string; widget?: string; markdown?: string; props?: Record<string, string> }[] };
    };

    // First call: the server shows the steps and two hidden fields; the agent only learns that it did.
    const ask = await call(anna, { platform: "instagram" });
    expect(ask.told.step).toBe("asked_for_app_keys");
    expect(ask.show[0]!.markdown).toContain("https://api.example.com/plugins/oauth/callback");
    expect(ask.show.filter((block) => block.widget === "secret").map((block) => block.props!.envName)).toEqual(["INSTAGRAM_APP_KEY_AAAAAAAA", "INSTAGRAM_APP_SECRET_AAAAAAAA"]);

    // The person fills in one field only: the server asks for the other one alone.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_KEY_AAAAAAAA", secret: "anna-app-id" });
    const half = await call(anna, { platform: "instagram" });
    expect(half.show.filter((block) => block.widget === "secret").map((block) => block.props!.envName)).toEqual(["INSTAGRAM_APP_SECRET_AAAAAAAA"]);

    // Both are in: the keys move out of the vault, and the person is sent a link on this server.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_SECRET_AAAAAAAA", secret: "anna-app-secret" });
    const link = await call(anna, { platform: "instagram" });
    expect(link.told.step).toBe("sent_sign_in_link");
    expect(link.show[0]!.markdown).toMatch(/\(https:\/\/api\.example\.com\/plugins\/connect\/[\w-]+\)/);
    expect(await takeSecret(db, account.id, "INSTAGRAM_APP_KEY_AAAAAAAA")).toBeNull();
    expect(await takeSecret(db, account.id, "INSTAGRAM_APP_SECRET_AAAAAAAA")).toBeNull();
    // That short link forwards to Instagram with Anna's own app.
    const instagram = catalogPlugin("instagram")!;
    const started = await startSocialOAuth(db, account.id, instagram, anna);
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe("anna-app-id");
    expect(peekPending(started.url.split("/plugins/connect/")[1]!)?.url).toBe(started.authorizeUrl);

    // The person signs in (the redirect saves the token for that agent).
    await saveSocialAccount(db, account.id, instagram, token("11", "annas_brand"), anna);
    expect((await call(anna, { platform: "instagram" })).told).toMatchObject({ step: "connected", connectedAccounts: ["@annas_brand"], belongsTo: "you only" });

    // The connection is Anna's: Ben has no tools and no token, and would have to bring his own keys.
    const [row] = await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, account.id), eq(mcpServers.slug, "instagram")));
    expect(socialUsableBy(row!, anna)).toBe(true);
    expect(socialUsableBy(row!, ben)).toBe(false);
    await expect(socialAccessToken(db, account.id, "instagram", undefined, ben)).rejects.toThrow(/No Instagram account is connected for you/);
    expect((await call(ben, { platform: "instagram" })).told.step).toBe("asked_for_app_keys");
    expect((await socialAccessToken(db, account.id, "instagram", undefined, anna)).token).toBe("token-annas_brand");

    // Ben connects another brand with another app. Each agent acts with its own.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_KEY_BBBBBBBB", secret: "ben-app-id" });
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_SECRET_BBBBBBBB", secret: "ben-app-secret" });
    expect((await call(ben, { platform: "instagram" })).told.step).toBe("sent_sign_in_link");
    expect(new URL((await startSocialOAuth(db, account.id, instagram, ben)).authorizeUrl).searchParams.get("client_id")).toBe("ben-app-id");
    await saveSocialAccount(db, account.id, instagram, token("22", "bens_brand"), ben);
    expect((await socialAccessToken(db, account.id, "instagram", undefined, ben)).token).toBe("token-bens_brand");
    expect((await socialAccessToken(db, account.id, "instagram", undefined, anna)).token).toBe("token-annas_brand");

    // Anna signs hers out; Ben's stays.
    expect((await call(anna, { platform: "instagram", disconnect: true })).told).toMatchObject({ step: "disconnected", removed: ["@annas_brand"] });
    await expect(socialAccessToken(db, account.id, "instagram", undefined, anna)).rejects.toThrow(/No Instagram account is connected for you/);
    expect((await socialAccessToken(db, account.id, "instagram", undefined, ben)).token).toBe("token-bens_brand");
    expect((await call(anna, { platform: "youtube" })).told).toMatchObject({ error: expect.stringMatching(/instagram or tiktok/) });

    // Through all of it the agents were never told a key, a secret, a token, or an address carrying one.
    const everything = said.join("\n");
    expect(everything).not.toMatch(/anna-app|ben-app|token-|client_id|instagram\.com\/oauth|plugins\/connect/);
  });

  it("keeps one account's sign-ins away from another", async () => {
    const first = await createAccount(db, { name: "First" });
    const second = await createAccount(db, { name: "Second" });
    await saveSocialAccount(db, first.id, catalogPlugin("tiktok")!, token("9", "first_tiktok"));
    await expect(socialAccessToken(db, second.id, "tiktok")).rejects.toThrow(/No TikTok account is connected for you/);
    await expect(socialAccessToken(db, second.id, "tiktok", undefined, "cccccccc-3333-4333-8333-333333333333")).rejects.toThrow(/No TikTok account is connected for you/);
  });
});
