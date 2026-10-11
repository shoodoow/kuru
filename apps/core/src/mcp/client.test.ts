import { describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools, McpAuthError, MCP_PROTOCOL_VERSION, toolResultText } from "./client.js";
import { authorizationMetadataUrls, resourceOf } from "./mcp-oauth.js";
import { mcpToolName } from "./tools.js";

type Seen = { method: string; authorization: string | undefined; session: string | undefined; version: string | undefined };
type Options = {
  eventStream?: boolean;
  /** The HTTP status and JSON-RPC error a tool call gets. */
  failCall?: { status: number; message: string };
  /** Tool names, split over pages of this size. */
  tools?: string[];
  pageSize?: number;
};

/** A stand-in MCP server: answers initialize, tools/list and tools/call, and records what it was sent. */
function fakeServer(options: Options = {}) {
  const seen: Seen[] = [];
  let live = "session-1";
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    if (init?.method === "DELETE") {
      seen.push({ method: "DELETE", authorization: headers.authorization, session: headers["mcp-session-id"], version: headers["mcp-protocol-version"] });
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: unknown; cursor?: string } };
    seen.push({ method: body.method, authorization: headers.authorization, session: headers["mcp-session-id"], version: headers["mcp-protocol-version"] });
    const reply = (message: Record<string, unknown>, status = 200) => {
      const json = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...message });
      // On a stream the server reports progress first and then answers, pretty-printed over several data lines.
      const progress = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
      const answer = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...message }, null, 1).split("\n").map((line) => `data: ${line}`).join("\n");
      const stream = `event: message\ndata: ${progress}\n\nevent: message\n${answer}\n\n`;
      return new Response(options.eventStream ? stream : json, {
        status,
        headers: { "mcp-session-id": live, "content-type": options.eventStream ? "text/event-stream" : "application/json" },
      });
    };
    // A session the server no longer knows is answered with 404.
    if (body.method !== "initialize" && headers["mcp-session-id"] !== live) return reply({ error: { code: -32001, message: "Session not found." } }, 404);
    if (body.method === "initialize") return reply({ result: { protocolVersion: "2025-03-26" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      const names = options.tools ?? ["find"];
      const size = options.pageSize ?? names.length;
      const start = Number(body.params?.cursor ?? 0);
      const next = start + size < names.length ? String(start + size) : undefined;
      return reply({ result: { tools: names.slice(start, start + size).map((name) => ({ name, inputSchema: { type: "object" } })), nextCursor: next } });
    }
    if (options.failCall) return reply({ error: { code: -32000, message: options.failCall.message } }, options.failCall.status);
    return reply({ result: { content: [{ type: "text", text: `ran ${body.params?.name}` }] } });
  }) as typeof fetch;
  return {
    seen,
    fetchImpl,
    forget: () => {
      live = "session-2";
    },
  };
}

describe("MCP client on the core", () => {
  it("lists tools, sends the bearer every time, and uses the session and version the server chose", async () => {
    const server = fakeServer();
    const tools = await listMcpTools("https://mcp.example.com/mcp", "secret-token", server.fetchImpl);
    expect(tools).toEqual([{ name: "find", description: "", inputSchema: { type: "object" } }]);
    expect(server.seen.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(server.seen.every((message) => message.authorization === "Bearer secret-token")).toBe(true);
    expect(server.seen.map((message) => message.session)).toEqual([undefined, "session-1", "session-1"]);
    // Nothing is claimed before the handshake; after it, the server's choice is repeated.
    expect(server.seen.map((message) => message.version)).toEqual([undefined, "2025-03-26", "2025-03-26"]);
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("reuses the open session for the next call, and opens a new one when the server has forgotten it", async () => {
    const server = fakeServer();
    await callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, server.fetchImpl);
    await callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, server.fetchImpl);
    expect(server.seen.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);

    server.forget();
    await expect(callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, server.fetchImpl)).resolves.toBeTruthy();
    expect(server.seen.map((message) => message.method).slice(4)).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
  });

  it("reads every page of a long tool list", async () => {
    const server = fakeServer({ tools: ["a", "b", "c", "d", "e"], pageSize: 2 });
    const tools = await listMcpTools("https://mcp.example.com/mcp", "", server.fetchImpl);
    expect(tools.map((tool) => tool.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("picks its own answer out of an event stream that reports progress first", async () => {
    const server = fakeServer({ eventStream: true });
    const result = await callMcpTool("https://mcp.example.com/mcp", "", "find", { q: "x" }, server.fetchImpl);
    expect(result).toEqual({ content: [{ type: "text", text: "ran find" }] });
    expect(server.seen[0]?.authorization).toBeUndefined();
  });

  it("raises the server's error whether it comes with a failure status or inside a 200", async () => {
    const refused = fakeServer({ failCall: { status: 500, message: "The service is down." } });
    await expect(callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, refused.fetchImpl)).rejects.toThrow("The service is down.");
    const quiet = fakeServer({ failCall: { status: 200, message: "Unknown tool." } });
    await expect(callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, quiet.fetchImpl)).rejects.toThrow("Unknown tool.");
  });

  it("marks a refused token so the caller can refresh it", async () => {
    const server = fakeServer({ failCall: { status: 401, message: "The token was refused." } });
    await expect(callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, server.fetchImpl)).rejects.toBeInstanceOf(McpAuthError);
  });

  it("refuses a private address before any request is made", async () => {
    const server = fakeServer();
    await expect(listMcpTools("http://127.0.0.1:5432/mcp", "t", server.fetchImpl)).rejects.toThrow(/public endpoints/);
    await expect(listMcpTools("https://host.docker.internal/mcp", "t", server.fetchImpl)).rejects.toThrow();
    expect(server.seen).toHaveLength(0);
  });
});

describe("what an agent reads from a tool result", () => {
  it("joins the text and names what it cannot show", () => {
    expect(
      toolResultText({ content: [{ type: "text", text: "Two issues." }, { type: "image", mimeType: "image/png", data: "AAAA" }, { type: "text", text: "Done." }] }),
    ).toEqual({ text: "Two issues.\n[image (image/png) was returned and is not shown]\nDone.", failed: false });
  });

  it("says when the tool failed", () => {
    expect(toolResultText({ isError: true, content: [{ type: "text", text: "No such repo." }] })).toEqual({
      text: "The tool reported an error: No such repo.",
      failed: true,
    });
  });

  it("falls back to structured data, and to a plain line when there is nothing", () => {
    expect(toolResultText({ content: [], structuredContent: { count: 3 } }).text).toBe('{"count":3}');
    expect(toolResultText({ content: [] }).text).toBe("Done. The tool returned nothing.");
  });
});

describe("tool names shown to a model", () => {
  it("keeps only characters providers accept and stays within 64", () => {
    expect(mcpToolName("github", "issues.create", new Set())).toBe("github_issues_create");
    expect(mcpToolName("files", "read/file v2", new Set())).toBe("files_read_file_v2");
    expect(mcpToolName("crm", "x".repeat(90), new Set())).toHaveLength(64);
  });

  it("keeps two tools apart when their cleaned names match", () => {
    expect(mcpToolName("crm", "find.user", new Set(["crm_find_user"]))).toBe("crm_find_user_2");
  });
});

describe("MCP sign-in addresses", () => {
  it("asks for a token for the server itself, without a fragment", () => {
    expect(resourceOf("https://mcp.example.com/mcp#x")).toBe("https://mcp.example.com/mcp");
  });

  it("looks for authorization metadata in every standard place", () => {
    expect(authorizationMetadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
    expect(authorizationMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
      "https://auth.example.com/tenant1/.well-known/oauth-authorization-server",
    ]);
  });
});
