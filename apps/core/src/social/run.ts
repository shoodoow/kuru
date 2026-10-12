/**
 * Runs one Instagram or TikTok tool for an account.
 * Why on the server: the sign-in is opened and used here, so no token is ever
 * written into the account's computer where an agent could read it.
 */
import type { getDb } from "../db/client.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { socialAccessToken } from "./accounts.js";
import type { Args } from "./http.js";
import { instagram } from "./instagram.js";
import { tiktok } from "./tiktok.js";
import type { Computer } from "./youtube.js";

type Database = ReturnType<typeof getDb>;
const MAX_OUTPUT = 20_000;

/**
 * Input: database, whose computer files come from, the plugin slug, tool name and arguments.
 * Output: the result as JSON text, or a plain sentence when the call failed.
 */
export async function runSocialTool(db: Database, computer: Computer, slug: string, toolName: string, args: Args): Promise<string> {
  try {
    const provider = catalogPlugin(slug)?.provider;
    const which = typeof args.account === "string" ? args.account : undefined;
    const { token, connected } = await socialAccessToken(db, computer.accountId, slug, which);
    const answer = provider === "instagram" ? await instagram(toolName, args, token, computer) : await tiktok(toolName, args, token, computer);
    // With several accounts connected, the agent is shown the others so it can tell them apart.
    const result = toolName === "account" && connected.length > 1 ? { ...(answer as object), connectedAccounts: connected } : answer;
    const text = JSON.stringify(result);
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
  } catch (error) {
    return error instanceof Error ? error.message : "The call failed.";
  }
}
