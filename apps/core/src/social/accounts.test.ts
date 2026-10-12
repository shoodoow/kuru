import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { listAccountPlugins } from "../mcp/plugins.js";
import { deleteMcpServer } from "../mcp/store.js";
import { createAccount } from "../roster/roster.js";
import { and, eq } from "drizzle-orm";
import { mcpServers } from "../db/schema.js";
import { saveSecret, takeSecret } from "../keys/secrets.js";
import { saveSocialAccount, saveSocialApp, socialAccessToken, socialUsableBy, startSocialOAuth, type StoredToken } from "./accounts.js";
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

    const card = (await listAccountPlugins(db, account.id)).plugins.find((plugin) => plugin.id === "instagram");
    expect(card).toMatchObject({ installed: true, configured: true, multiAccount: true, accounts: ["@brand_two", "@brand_one"] });
    // The card never carries a token.
    expect(JSON.stringify(card)).not.toContain("token-");

    await deleteMcpServer(db, account.id, "instagram");
    await expect(socialAccessToken(db, account.id, "instagram")).rejects.toThrow(/No Instagram account is connected for you/);
  });

  it("signs each account in with the developer app that account added", async () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    const account = await createAccount(db, { name: "Own app" });
    const other = await createAccount(db, { name: "No app" });
    const tiktok = catalogPlugin("tiktok")!;
    // Nothing in the server's settings and nothing added: the person is told what to do.
    await expect(startSocialOAuth(db, account.id, tiktok)).rejects.toThrow(/Add your TikTok app's client key and secret first/);
    await expect(saveSocialApp(db, account.id, "tiktok", { key: "", secret: "x" })).rejects.toThrow(/client key and the client secret/);
    await expect(saveSocialApp(db, account.id, "gmail", { key: "a", secret: "b" })).rejects.toThrow(/does not use its own app keys/);

    await saveSocialApp(db, account.id, "tiktok", { key: " aw-my-client-key ", secret: "s3cret-value" });
    const started = new URL((await startSocialOAuth(db, account.id, tiktok)).url);
    expect(started.origin + started.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(started.searchParams.get("client_key")).toBe("aw-my-client-key");
    expect(started.searchParams.get("redirect_uri")).toBe("https://api.example.com/plugins/oauth/callback");
    expect(started.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,user.info.stats,video.list,video.publish,video.upload");

    // Keys alone do not make the plugin installed, and they never come back to the phone.
    const before = (await listAccountPlugins(db, account.id)).plugins.find((plugin) => plugin.id === "tiktok")!;
    expect(before).toMatchObject({ installed: false, app: { saved: true, keyLabel: "Client key", redirect: "https://api.example.com/plugins/oauth/callback" } });
    expect(JSON.stringify(before)).not.toContain("s3cret-value");
    expect(JSON.stringify(before)).not.toContain("aw-my-client-key");
    // Another account has no keys of its own and cannot use these.
    expect((await listAccountPlugins(db, other.id)).plugins.find((plugin) => plugin.id === "tiktok")?.app?.saved).toBe(false);
    await expect(startSocialOAuth(db, other.id, tiktok)).rejects.toThrow(/Add your TikTok app/);

    // Signing in keeps the keys; changing the keys keeps who is signed in.
    await saveSocialAccount(db, account.id, tiktok, token("7", "my_tiktok"));
    expect(new URL((await startSocialOAuth(db, account.id, tiktok)).url).searchParams.get("client_key")).toBe("aw-my-client-key");
    await saveSocialApp(db, account.id, "tiktok", { key: "aw-second-key", secret: "another" });
    expect((await socialAccessToken(db, account.id, "tiktok")).token).toBe("token-my_tiktok");
    expect((await listAccountPlugins(db, account.id)).plugins.find((plugin) => plugin.id === "tiktok")).toMatchObject({ installed: true, accounts: ["@my_tiktok"] });
  });

  it("connects one agent from its chat, and keeps that connection from the other agents", async () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    const account = await createAccount(db, { name: "Two brands" });
    const anna = "aaaaaaaa-1111-4111-8111-111111111111";
    const ben = "bbbbbbbb-2222-4222-8222-222222222222";

    // First call: nothing is there, so the agent is told which two secrets to ask for.
    const ask = (await connectSocial(db, account.id, anna, { platform: "instagram" })) as { step: string; do: string; redirectAddress: string };
    expect(ask.step).toBe("ask_for_app_keys");
    expect(ask.do).toContain('envName: "INSTAGRAM_APP_KEY_AAAAAAAA"');
    expect(ask.do).toContain('envName: "INSTAGRAM_APP_SECRET_AAAAAAAA"');
    expect(ask.redirectAddress).toBe("https://api.example.com/plugins/oauth/callback");

    // The person fills in one widget only: the agent is told which is missing.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_KEY_AAAAAAAA", secret: "anna-app-id" });
    expect(((await connectSocial(db, account.id, anna, { platform: "instagram" })) as { note: string }).note).toMatch(/Only the Instagram app ID has arrived/);

    // Both are in: the keys move out of the vault and the agent gets a sign-in link made with them.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_SECRET_AAAAAAAA", secret: "anna-app-secret" });
    const link = (await connectSocial(db, account.id, anna, { platform: "instagram" })) as { step: string; signInLink: string };
    expect(link.step).toBe("send_sign_in_link");
    expect(new URL(link.signInLink).searchParams.get("client_id")).toBe("anna-app-id");
    expect(await takeSecret(db, account.id, "INSTAGRAM_APP_KEY_AAAAAAAA")).toBeNull();
    expect(await takeSecret(db, account.id, "INSTAGRAM_APP_SECRET_AAAAAAAA")).toBeNull();

    // The person signs in (the redirect saves the token for that agent).
    const instagram = catalogPlugin("instagram")!;
    await saveSocialAccount(db, account.id, instagram, token("11", "annas_brand"), anna);
    expect(await connectSocial(db, account.id, anna, { platform: "instagram" })).toMatchObject({ step: "connected", connectedAccounts: ["@annas_brand"], belongsTo: "you only" });

    // The connection is Anna's: Ben has no tools and no token, and would have to bring his own keys.
    const [row] = await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, account.id), eq(mcpServers.slug, "instagram")));
    expect(socialUsableBy(row!, anna)).toBe(true);
    expect(socialUsableBy(row!, ben)).toBe(false);
    await expect(socialAccessToken(db, account.id, "instagram", undefined, ben)).rejects.toThrow(/No Instagram account is connected for you/);
    expect(((await connectSocial(db, account.id, ben, { platform: "instagram" })) as { step: string }).step).toBe("ask_for_app_keys");
    expect((await socialAccessToken(db, account.id, "instagram", undefined, anna)).token).toBe("token-annas_brand");

    // Ben connects another brand with another app. Each agent acts with its own.
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_KEY_BBBBBBBB", secret: "ben-app-id" });
    await saveSecret(db, account.id, { name: "INSTAGRAM_APP_SECRET_BBBBBBBB", secret: "ben-app-secret" });
    const bens = (await connectSocial(db, account.id, ben, { platform: "instagram" })) as { signInLink: string };
    expect(new URL(bens.signInLink).searchParams.get("client_id")).toBe("ben-app-id");
    await saveSocialAccount(db, account.id, instagram, token("22", "bens_brand"), ben);
    expect((await socialAccessToken(db, account.id, "instagram", undefined, ben)).token).toBe("token-bens_brand");
    expect((await socialAccessToken(db, account.id, "instagram", undefined, anna)).token).toBe("token-annas_brand");

    // The phone shows who is connected and to which agent, and no key or token.
    const card = (await listAccountPlugins(db, account.id)).plugins.find((plugin) => plugin.id === "instagram")!;
    expect(card.installed).toBe(true);
    expect(card.accounts).toEqual(["@annas_brand (one agent)", "@bens_brand (one agent)"]);
    expect(JSON.stringify(card)).not.toMatch(/anna-app|ben-app|token-/);
    expect(await connectSocial(db, account.id, anna, { platform: "youtube" })).toMatchObject({ error: expect.stringMatching(/instagram or tiktok/) });
  });

  it("keeps one account's sign-ins away from another", async () => {
    const first = await createAccount(db, { name: "First" });
    const second = await createAccount(db, { name: "Second" });
    await saveSocialAccount(db, first.id, catalogPlugin("tiktok")!, token("9", "first_tiktok"));
    await expect(socialAccessToken(db, second.id, "tiktok")).rejects.toThrow(/No TikTok account is connected for you/);
    expect((await listAccountPlugins(db, second.id)).plugins.find((plugin) => plugin.id === "tiktok")?.installed).toBe(false);
  });
});
