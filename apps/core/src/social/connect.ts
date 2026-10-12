/**
 * Connecting Instagram or TikTok from inside a chat.
 * Why in chat: the app keys belong to the person, and often to one agent's
 * job (this agent runs brand A's accounts, that one brand B's). The agent
 * asks for the two values with secret widgets, so they are typed into a
 * masked field and never appear in the conversation, then hands the person a
 * sign-in link. One tool walks the whole way; each call says what comes next.
 * The values rest in the account's vault only until the next call, which
 * moves them into the plugin's own sealed row and removes them from the vault.
 */
import type { getDb } from "../db/client.js";
import { takeSecret } from "../keys/secrets.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { pluginCallbackUrl } from "../mcp/oauth-pending.js";
import { saveSocialApp, socialStateFor, startSocialOAuth } from "./accounts.js";

type Database = ReturnType<typeof getDb>;

/**
 * Takes the next step in connecting a platform for one agent.
 * Input: database, account id, the agent asking, and { platform, forAllAgents, newKeys }.
 * Output: what the agent should do now, with the exact secret names to ask for or the link to send.
 */
export async function connectSocial(db: Database, accountId: string, agentId: string, input: Record<string, unknown>): Promise<unknown> {
  const platform = String(input.platform ?? "").toLowerCase();
  const plugin = catalogPlugin(platform);
  if (!plugin?.app || (platform !== "instagram" && platform !== "tiktok")) {
    return { error: "platform must be instagram or tiktok. YouTube is added by the person on the Plugins page with their Google sign-in." };
  }
  const shared = input.forAllAgents === true;
  const owner = shared ? undefined : agentId;
  // The names carry the agent, so two agents asking at once cannot pick up each other's values.
  const tag = shared ? "SHARED" : agentId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const keyName = `${platform.toUpperCase()}_APP_KEY_${tag}`;
  const secretName = `${platform.toUpperCase()}_APP_SECRET_${tag}`;

  const state = await socialStateFor(db, accountId, platform, owner);
  const wantsKeys = input.newKeys === true || !(shared ? state.ownApp : state.anyApp);
  if (wantsKeys) {
    const key = await takeSecret(db, accountId, keyName, false);
    const secret = await takeSecret(db, accountId, secretName, false);
    if (key && secret) {
      await saveSocialApp(db, accountId, platform, { key, secret }, owner);
      await takeSecret(db, accountId, keyName);
      await takeSecret(db, accountId, secretName);
    } else {
      return {
        step: "ask_for_app_keys",
        do: `Tell the person in a sentence what you need and why, then send ONE message with the setup steps as text and two secret widgets: props { envName: "${keyName}", label: "${plugin.app.keyLabel}" } and props { envName: "${secretName}", label: "${plugin.app.secretLabel}" }. The turn ends there. When they have filled both in, call connect_social again with the same arguments.`,
        ...(key || secret ? { note: `Only the ${key ? plugin.app.keyLabel : plugin.app.secretLabel} has arrived so far. Ask for the other one.` } : {}),
        stepsForThePerson: plugin.app.steps,
        developerPage: plugin.app.portal,
        redirectAddress: pluginCallbackUrl(),
      };
    }
  }

  const link = (await startSocialOAuth(db, accountId, plugin, owner)).url;
  const now = await socialStateFor(db, accountId, platform, owner);
  if (now.accounts.length > 0 && input.addAccount !== true && input.newKeys !== true) {
    return {
      step: "connected",
      connectedAccounts: now.accounts,
      belongsTo: now.own ? "you only" : "every agent on this account",
      do: `${plugin.name} is connected. Use the ${platform}_ tools${plugin.tools.length > 12 ? ` (load them with ${platform}_load_tools)` : ""} from your next turn. To connect one more account, call connect_social with addAccount: true.`,
    };
  }
  return {
    step: "send_sign_in_link",
    do: `Send the person this link and ask them to open it and sign in to the ${plugin.name} account you should use. It works for ten minutes. When they say they are done, call connect_social again with only the platform${shared ? " and forAllAgents" : ""} to confirm.`,
    signInLink: link,
    ...(now.accounts.length > 0 ? { alreadyConnected: now.accounts } : {}),
  };
}
