import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { createAccount } from "../roster/roster.js";
import type { ToolContext } from "../turn/tools/context.js";
import { activeDispatcherTools } from "../turn/tools/tool-sets.js";
import { readSecret } from "./credential.js";
import { finishMcpOAuth, startMcpOAuth } from "./mcp-oauth.js";
import { runMcpTool } from "./store.js";
import { appendMcpTools, LAZY_PLUGIN_TOOLS } from "./tools.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

const MCP = "https://mcp.example.com/mcp";
const TOOL_COUNT = LAZY_PLUGIN_TOOLS + 3;

/**
 * A stand-in for a signed-in MCP server and its authorization server, which
 * sits under a path and publishes only an OpenID document. It records what the
 * token endpoint is sent and accepts only the tokens in `valid`.
 */
function world() {
  const valid = new Set<string>();
  const tokenRequests: Record<string, string>[] = [];
  let issued = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return json({ authorization_servers: ["https://auth.example.com/t1"], scopes_supported: ["tools"] });
    }
    if (url === "https://auth.example.com/.well-known/openid-configuration/t1") {
      return json({
        authorization_endpoint: "https://auth.example.com/t1/authorize",
        token_endpoint: "https://auth.example.com/t1/token",
        registration_endpoint: "https://auth.example.com/t1/register",
      });
    }
    if (url === "https://auth.example.com/t1/register") return json({ client_id: "client-1" });
    if (url === "https://auth.example.com/t1/token") {
      const fields = Object.fromEntries(new URLSearchParams(String(init?.body)));
      tokenRequests.push(fields);
      issued += 1;
      const access = `access-${issued}`;
      valid.clear();
      valid.add(access);
      return json({ access_token: access, refresh_token: `refresh-${issued}`, expires_in: 3600 });
    }
    if (url === MCP && method === "GET") return new Response(null, { status: 401 });
    if (url === MCP && method === "POST") {
      const token = (init?.headers as Record<string, string>).authorization?.replace("Bearer ", "") ?? "";
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
      if (!valid.has(token)) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Token expired." } }, 401);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : body.method === "tools/list"
            ? { tools: Array.from({ length: TOOL_COUNT }, (_unused, index) => ({ name: `issues.tool${index}`, inputSchema: { type: "object" } })) }
            : { content: [{ type: "text", text: `ran ${body.params?.name} as ${token}` }] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, valid, tokenRequests };
}

describe("a signed-in MCP server, end to end", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("signs in, calls a tool, recovers from a refused token, and loads a large plugin on request", async () => {
    const account = await createAccount(db, { name: "MCP flow" });
    const { fetchImpl, valid, tokenRequests } = world();

    // Sign-in: the address the person is sent to names this server and carries a challenge.
    const started = await startMcpOAuth(db, account.id, "tracker", MCP, fetchImpl);
    const authorize = new URL(started.url);
    expect(authorize.origin + authorize.pathname).toBe("https://auth.example.com/t1/authorize");
    expect(authorize.searchParams.get("resource")).toBe(MCP);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    await finishMcpOAuth(db, authorize.searchParams.get("state")!, "code-1", fetchImpl);
    expect(tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-1", resource: MCP });
    expect(tokenRequests[0]!.code_verifier!.length).toBeGreaterThan(20);
    const stored = async () => (await db.select().from(mcpServers).where(and(eq(mcpServers.accountId, account.id), eq(mcpServers.slug, "tracker"))))[0]!;
    expect(await stored()).toMatchObject({ kind: "remote", lastError: null });
    expect(((await stored()).toolsCache as unknown[]).length).toBe(TOOL_COUNT);

    expect(await runMcpTool(db, account.id, "tracker", "issues.tool0", {}, fetchImpl)).toBe("ran issues.tool0 as access-1");

    // The server stops accepting the token before its stated expiry.
    valid.clear();
    expect(await runMcpTool(db, account.id, "tracker", "issues.tool0", {}, fetchImpl)).toBe("ran issues.tool0 as access-2");
    expect(tokenRequests[1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", resource: MCP });
    expect(readSecret((await stored()).secret).oauth).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });

    // With no way back in, the agent is told what to ask for.
    valid.clear();
    await db.update(mcpServers).set({ secret: (await import("../keys/keys.js")).seal("a-pasted-token") }).where(eq(mcpServers.id, (await stored()).id));
    expect(await runMcpTool(db, account.id, "tracker", "issues.tool0", {}, fetchImpl)).toMatch(/connect it again/);

    // The chat agent sees one "load" tool for a plugin this large, then its tools once loaded.
    const ctx = { db, accountId: account.id, enabledToolSets: new Set<string>(), pluginGates: new Map(), pluginLoaders: new Map() } as unknown as ToolContext;
    const set: Record<string, unknown> = {};
    await appendMcpTools(ctx, set, (_name, execute) => execute);
    const names = Object.keys(set);
    expect(names).toContain("tracker_load_tools");
    expect(names).toContain("tracker_issues_tool0");
    const gates = { gates: ctx.pluginGates, loaders: ctx.pluginLoaders };
    expect(activeDispatcherTools(names, ctx.enabledToolSets!, new Set(), gates)).toEqual(["tracker_load_tools"]);
    await (set.tracker_load_tools as { execute: (input: object) => Promise<unknown> }).execute({});
    const after = activeDispatcherTools(names, ctx.enabledToolSets!, new Set(), gates);
    expect(after).toHaveLength(TOOL_COUNT);
    expect(after).not.toContain("tracker_load_tools");

    // A worker has no such gate and gets every tool.
    const workerSet: Record<string, unknown> = {};
    await appendMcpTools({ db, accountId: account.id } as unknown as ToolContext, workerSet, (_name, execute) => execute);
    expect(Object.keys(workerSet)).toHaveLength(TOOL_COUNT);
  });
});
