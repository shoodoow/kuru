import { afterAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { accounts, mcpServers } from "../db/schema.js";
import { discoverMcpOAuth, startMcpOAuth } from "./mcp-oauth.js";
import { catalogPlugin } from "./catalog.js";
import { startGoogleOAuth } from "./google-oauth.js";
import { applyGoogleConnection, googleRefreshToken, listAccountPlugins } from "./plugins.js";
import { deleteMcpServer, saveMcpServer } from "./store.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

afterAll(async () => {
  await db.$client.end();
});

test("a Google plugin stays on the account that installed it and the token is not returned", async () => {
  const [a] = await db.insert(accounts).values({ name: "Plugin A" }).returning();
  const [b] = await db.insert(accounts).values({ name: "Plugin B" }).returning();
  const token = "refresh-token-should-not-leak";
  await applyGoogleConnection(db, a!.id, "gmail", token, "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose");
  const own = await listAccountPlugins(db, a!.id);
  const other = await listAccountPlugins(db, b!.id);
  expect(own.plugins.find((plugin) => plugin.id === "gmail")?.installed).toBe(true);
  expect(other.plugins.find((plugin) => plugin.id === "gmail")?.installed).toBe(false);
  expect(JSON.stringify(own)).not.toContain(token);
  expect(JSON.stringify(other)).not.toContain(token);
  await deleteMcpServer(db, a!.id, "gmail");
  expect(await googleRefreshToken(db, a!.id, "gmail")).toBeNull();
  await db.delete(mcpServers).where(eq(mcpServers.accountId, a!.id));
  await db.delete(mcpServers).where(eq(mcpServers.accountId, b!.id));
  await db.delete(accounts).where(eq(accounts.id, a!.id));
  await db.delete(accounts).where(eq(accounts.id, b!.id));
});

test("each Google plugin asks only for its own scopes and keeps its own sign-in", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  const [account] = await db.insert(accounts).values({ name: "Plugin Scopes" }).returning();
  const gmailScopes = catalogPlugin("gmail")!.scopes.join(" ");
  await applyGoogleConnection(db, account!.id, "gmail", "refresh-token-gmail", gmailScopes);
  const started = await startGoogleOAuth(db, account!.id, "youtube");
  const scope = new URL(started.url).searchParams.get("scope") ?? "";
  expect(scope).not.toContain("gmail");
  expect(new URL(started.url).searchParams.get("prompt")).toContain("select_account");
  expect(started.url).not.toContain(account!.id);
  // YouTube on another Google account (a brand account) leaves Gmail's sign-in alone.
  await applyGoogleConnection(db, account!.id, "youtube", "refresh-token-brand", catalogPlugin("youtube")!.scopes.join(" "));
  expect((await googleRefreshToken(db, account!.id, "gmail"))?.refreshToken).toBe("refresh-token-gmail");
  expect((await googleRefreshToken(db, account!.id, "youtube"))?.refreshToken).toBe("refresh-token-brand");
  const cards = (await listAccountPlugins(db, account!.id)).plugins;
  expect(cards.find((plugin) => plugin.id === "gmail")?.configured).toBe(true);
  expect(cards.find((plugin) => plugin.id === "youtube")?.configured).toBe(true);
  await db.delete(mcpServers).where(eq(mcpServers.accountId, account!.id));
  await db.delete(accounts).where(eq(accounts.id, account!.id));
});

test("custom MCP rejects a private URL and a reserved plugin name", async () => {
  const [account] = await db.insert(accounts).values({ name: "Plugin URL" }).returning();
  await expect(startMcpOAuth(db, account!.id, "notes", "http://127.0.0.1:9/mcp")).rejects.toThrow(/public endpoints/);
  await expect(saveMcpServer(db, account!.id, { slug: "gmail", url: "https://example.com/mcp", secret: "x" })).rejects.toThrow(/reserved/);
  expect(await listAccountPlugins(db, account!.id)).toMatchObject({ installed: 0 });
  await db.delete(accounts).where(eq(accounts.id, account!.id));
});

test("MCP OAuth discovery reads protected-resource metadata", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/mcp")) {
      return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"' } });
    }
    if (String(url).endsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ authorization_servers: ["https://example.com"], scopes_supported: ["tools"] });
    }
    if (String(url).includes("oauth-authorization-server")) {
      return Response.json({
        authorization_endpoint: "https://example.com/authorize",
        token_endpoint: "https://example.com/token",
        registration_endpoint: "https://example.com/register",
      });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const discovered = await discoverMcpOAuth("https://example.com/mcp", fetchImpl);
  expect(discovered?.authorizationEndpoint).toBe("https://example.com/authorize");
  expect(discovered?.tokenEndpoint).toBe("https://example.com/token");
});
