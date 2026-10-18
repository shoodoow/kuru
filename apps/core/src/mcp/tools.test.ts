import { afterAll, describe, expect, it } from "vitest";
import { asSchema } from "ai";
import { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { createAccount } from "../roster/roster.js";
import type { ToolContext } from "../turn/tools/context.js";
import { activeDispatcherTools, activeWorkerTools } from "../turn/tools/tool-sets.js";
import { appendMcpTools, clipSchemaDescriptions, LOAD_TOOLS_PER_CALL, matchPluginTools } from "./tools.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

/** A server shaped like the email plugin that added 110,000 tokens to every worker step. */
const HUGE = Array.from({ length: 137 }, (_unused, index) => ({
  name: index === 0 ? "send-email" : index === 1 ? "list-domains" : `action-${index}`,
  description: `${index === 0 ? "Send an email to one or more recipients." : "Does one account thing."} ${"Long documentation. ".repeat(60)}`,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 6 }, (_none, field) => [`field${field}`, { type: "string", description: "Field docs. ".repeat(80) }]),
    ),
  },
}));

/** Characters of tool definitions a provider receives for the tools on offer. */
function offeredChars(set: Record<string, unknown>, names: string[]): number {
  return names.reduce((total, name) => {
    const entry = set[name] as { description?: string; inputSchema?: unknown };
    return total + name.length + (entry.description?.length ?? 0) + JSON.stringify(asSchema(entry.inputSchema as never).jsonSchema).length;
  }, 0);
}

describe("connector tools stay small on every step", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("offers a 137-tool plugin as one load tool, then only the tools asked for, to workers and chat alike", async () => {
    const account = await createAccount(db, { name: "Huge plugin" });
    await db.insert(mcpServers).values({ accountId: account.id, slug: "mail", url: "http://127.0.0.1:1/mcp", toolsCache: HUGE, kind: "remote" });
    const ctx = {
      db,
      accountId: account.id,
      enabledToolSets: new Set<string>(),
      pluginGates: new Map<string, string>(),
      pluginLoaders: new Map<string, string>(),
    } as unknown as ToolContext;
    const set: Record<string, unknown> = {};
    await appendMcpTools(ctx, set, (_name, execute) => execute);
    const gates = { gates: ctx.pluginGates, loaders: ctx.pluginLoaders };
    const names = Object.keys(set);

    // Before loading: one tool, a few hundred characters.
    expect(activeWorkerTools(names, ctx.enabledToolSets!, gates)).toEqual(["mail_load_tools"]);
    expect(activeDispatcherTools(names, ctx.enabledToolSets!, new Set(), gates)).toEqual(["mail_load_tools"]);
    expect(offeredChars(set, ["mail_load_tools"])).toBeLessThan(1_500);

    // Loading by search turns on a handful, not all 137.
    const load = set.mail_load_tools as { execute: (input: object) => Promise<{ loaded: number; tools: string[] }> };
    const result = await load.execute({ search: "send email" });
    expect(result.loaded).toBeGreaterThan(0);
    expect(result.loaded).toBeLessThanOrEqual(LOAD_TOOLS_PER_CALL);
    expect(result.tools[0]).toMatch(/^mail_send-email/);
    const after = activeWorkerTools(names, ctx.enabledToolSets!, gates);
    expect(after).toContain("mail_send-email");
    expect(after).toContain("mail_load_tools");
    expect(after.length).toBeLessThanOrEqual(LOAD_TOOLS_PER_CALL + 1);
    // Even loaded, the clipped definitions stay far below the 400,000 characters the server sends.
    expect(offeredChars(set, after)).toBeLessThan(LOAD_TOOLS_PER_CALL * 2_500);

    // Loading by exact name works with the model's name or the server's.
    await load.execute({ tools: ["list-domains"] });
    expect(activeWorkerTools(names, ctx.enabledToolSets!, gates)).toContain("mail_list-domains");
  });

  it("ranks tools by name before description and drops what does not match", () => {
    const tools = [
      { name: "list-emails", description: "List sent emails." },
      { name: "create-contact", description: "Adds someone you can email later." },
      { name: "delete-domain", description: "Removes a domain." },
    ];
    expect(matchPluginTools(tools, "email").map((entry) => entry.name)).toEqual(["list-emails", "create-contact"]);
    expect(matchPluginTools(tools, "")).toEqual([]);
  });

  it("clips long descriptions anywhere in a schema", () => {
    const clipped = clipSchemaDescriptions({ description: "x".repeat(500), properties: { a: { description: "y".repeat(500), enum: ["description"] } } }, 20) as {
      description: string;
      properties: { a: { description: string; enum: string[] } };
    };
    expect(clipped.description).toHaveLength(20);
    expect(clipped.properties.a.description).toHaveLength(20);
    expect(clipped.properties.a.enum).toEqual(["description"]);
  });
});
