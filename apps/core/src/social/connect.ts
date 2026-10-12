/**
 * Connecting Instagram or TikTok from inside a chat.
 * Why in chat: the app keys belong to the person, and often to one agent's
 * job (this agent runs brand A's accounts, that one brand B's). The agent
 * asks for the two values with secret widgets, so they are typed into a
 * masked field and never appear in the conversation, then hands the person a
 * sign-in link. One tool walks the whole way; each call says what comes next.
 * The values rest in the account's vault only until the next call, which
 * moves them into the plugin's own sealed row and removes them from the vault.
 * What the agent can see: the names it asked for, and a short link on this
 * server. Never a key, a secret, a token, or the platform's sign-in address
 * (which carries the app's key). Nothing this returns contains one.
 */
import type { getDb } from "../db/client.js";
import { takeSecret } from "../keys/secrets.js";
import { catalogPlugin } from "../mcp/catalog.js";
import { pluginCallbackUrl } from "../mcp/oauth-pending.js";
import { removeSocialAccounts, saveSocialApp, socialStateFor, startSocialOAuth } from "./accounts.js";

type Database = ReturnType<typeof getDb>;

/**
 * What one call answers. `show` is a message the server posts to the person
 * itself (the hidden fields, the sign-in link); it is not given to the agent.
 * Why the server posts it: left to write a widget, a model sometimes types it
 * out as text, and the person sees words where the hidden field should be.
 */
export type ConnectAnswer = { step?: string; do?: string; error?: string; show?: unknown[]; [detail: string]: unknown };

/**
 * Takes the next step in connecting a platform for one agent.
 * Input: database, account id, the agent asking, and { platform, forAllAgents, addAccount, newKeys, disconnect, account }.
 * Output: what happened and what the agent does next, plus the message to show the person, if any.
 */
export async function connectSocial(db: Database, accountId: string, agentId: string, input: Record<string, unknown>): Promise<ConnectAnswer> {
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

  if (input.disconnect === true) {
    const removed = await removeSocialAccounts(db, accountId, platform, owner, typeof input.account === "string" ? input.account : undefined);
    return removed.length > 0
      ? { step: "disconnected", removed, do: `Tell the person ${removed.join(", ")} ${removed.length === 1 ? "is" : "are"} disconnected from ${plugin.name}.` }
      : { step: "nothing_to_disconnect", do: `No ${plugin.name} account${shared ? " shared by all agents" : " of yours"} matched. Tell the person what is connected, if anything.`, connectedAccounts: (await socialStateFor(db, accountId, platform, owner)).accounts };
  }
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
      const field = (envName: string, title: string) => ({
        kind: "widget",
        widget: "secret",
        props: { envName, title, description: `From your ${plugin.name} developer app.`, placeholder: `Paste the ${title.toLowerCase()}`, footnote: "Stored sealed on the server. Your agent never sees it." },
      });
      const missing = key ? [field(secretName, plugin.app.secretLabel)] : secret ? [field(keyName, plugin.app.keyLabel)] : [field(keyName, plugin.app.keyLabel), field(secretName, plugin.app.secretLabel)];
      const intro =
        key || secret
          ? `One more to go: the ${key ? plugin.app.secretLabel : plugin.app.keyLabel}.`
          : [
              `To connect ${plugin.name} I need the two keys of your own ${plugin.name} developer app. It is a one-time setup:`,
              "",
              ...plugin.app.steps.map((step, index) => `${index + 1}. ${step}`),
              "",
              `Developer page: ${plugin.app.portal}`,
              `Redirect address: \`${pluginCallbackUrl()}\``,
              "",
              "Then paste the two keys into the fields below. They go straight to the server and never appear in this chat.",
            ].join("\n");
      return {
        step: "asked_for_app_keys",
        do: "The person now sees the setup steps and hidden fields for the keys, and your turn has ended. Do not repeat the steps and never ask them to type a key into the chat. When they have filled the fields in you are woken: call connect_social again with the same arguments.",
        show: [{ kind: "text", markdown: intro }, ...missing],
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
    step: "sent_sign_in_link",
    do: `The person has been sent a sign-in link for ${plugin.name}. Do not send another. When they say they have signed in, call connect_social again with only the platform${shared ? " and forAllAgents" : ""} to confirm.`,
    show: [
      {
        kind: "text",
        markdown: `Last step: [sign in to ${plugin.name}](${link}) with the account I should use${now.accounts.length > 0 ? ` (already connected: ${now.accounts.join(", ")})` : ""}. The link works for ten minutes. Tell me when you are done.`,
      },
    ],
    ...(now.accounts.length > 0 ? { alreadyConnected: now.accounts } : {}),
  };
}
