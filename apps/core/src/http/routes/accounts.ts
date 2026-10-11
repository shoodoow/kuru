import { Router, type Request, type Response } from "express";
import { handBack, profileOnAccount, takeOver } from "../../desktop/desktop.js";
import { listProviderKeys, saveProviderKey } from "../../keys/keys.js";
import { saveSecret } from "../../keys/secrets.js";
import { createProfile } from "../../linux/linux.js";
import { startGoogleOAuth } from "../../mcp/google-oauth.js";
import { startMcpOAuth } from "../../mcp/mcp-oauth.js";
import { listAccountPlugins } from "../../mcp/plugins.js";
import { deleteMcpServer, listMcpServers, saveMcpServer } from "../../mcp/store.js";
import { createRoom, listConversations } from "../../rooms/rooms.js";
import { createAgent, defaultModelFor, ensureSupportAgentQuietly, listAgents, setDefaultModel } from "../../roster/roster.js";
import { listProposals } from "../../skills/proposals.js";
import { getAccountSettings, isTimeZone, listToolApprovals, rememberTimezone, setAutoReview } from "../../turn/auto-review.js";
import { logger, pathParam, type AppContext, type Database, type Guard } from "../context.js";
import { novncClientPage } from "../screen-client.js";
import { screenTokenKey } from "../screen-proxy.js";
import { mintScreenToken } from "../screen-token.js";
import { decideToolApprovalHttp } from "../wake.js";

/**
 * Routes under /accounts/:accountId: keys, plugins, agents, rooms, settings, approvals, screens, uploads.
 * Input: the request context and the session guard. Output: the router.
 */
export function accountsRoutes(ctx: AppContext, guard: Guard): Router {
  const accounts = Router();
  accounts.get("/:accountId/providers", guard, async (req, res) => {
    res.json(await listProviderKeys(ctx.db, pathParam(req, "accountId")));
  });
  accounts.put("/:accountId/providers", guard, async (req, res) => {
    res.json(await saveProviderKey(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.post("/:accountId/secrets", guard, async (req, res) => {
    // Write-only vault: the name echoes back, the value never does.
    try {
      res.status(201).json(await saveSecret(ctx.db, pathParam(req, "accountId"), req.body));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid secret." });
    }
  });
  accounts.get("/:accountId/plugins", guard, async (req, res) => {
    res.json(await listAccountPlugins(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/plugins/google/start", guard, async (req, res) => {
    try {
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      res.json(await startGoogleOAuth(ctx.db, pathParam(req, "accountId"), id));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not start Google sign-in." });
    }
  });
  accounts.post("/:accountId/plugins/mcp/oauth/start", guard, async (req, res) => {
    try {
      const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      res.json(await startMcpOAuth(ctx.db, pathParam(req, "accountId"), slug, url));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not start plugin sign-in." });
    }
  });
  accounts.get("/:accountId/mcp", guard, async (req, res) => {
    res.json(await listMcpServers(ctx.db, pathParam(req, "accountId")));
  });
  accounts.put("/:accountId/mcp", guard, async (req, res) => {
    res.json(await saveMcpServer(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.delete("/:accountId/mcp/:slug", guard, async (req, res) => {
    await deleteMcpServer(ctx.db, pathParam(req, "accountId"), pathParam(req, "slug"));
    res.status(204).end();
  });
  accounts.get("/:accountId/agents", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    // Accounts made before the default agent existed get theirs here.
    await ensureSupportAgentQuietly(ctx.db, accountId, ctx.generate);
    res.json(await listAgents(ctx.db, accountId));
  });
  accounts.post("/:accountId/agents", guard, async (req, res) => {
    res.status(201).json(await createAgent(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.get("/:accountId/conversations", guard, async (req, res) => {
    res.json(await listConversations(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/conversations", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    const created = await createRoom(ctx.db, accountId, req.body);
    if (!created) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    // Profiles are idempotent (existing usernames return as-is), so a retry
    // after a computer failure heals without duplicating anything. The room
    // itself is kept so the retry has something to attach to.
    try {
      for (const member of created.members) {
        await createProfile(ctx.db, accountId, member.agentId);
      }
    } catch (error) {
      logger.error({ err: error, accountId }, "agent profile setup failed");
      res.status(503).json({ error: "The account computer is starting. Retry in a few seconds." });
      return;
    }
    res.status(201).json(created);
  });
  accounts.get("/:accountId/proposals", guard, async (req, res) => {
    res.json(await listProposals(ctx.db, pathParam(req, "accountId")));
  });
  accounts.get("/:accountId/settings", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    const settings = await getAccountSettings(ctx.db, accountId);
    if (!settings) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ ...settings, defaultModel: await defaultModelFor(ctx.db, accountId) });
  });
  // Setup step two: the person names the model their agents start on. This is
  // what creates the default agent, which then writes its first message.
  accounts.put("/:accountId/default-model", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    const saved = await setDefaultModel(ctx.db, accountId, req.body);
    await ensureSupportAgentQuietly(ctx.db, accountId, ctx.generate);
    res.json(saved);
  });
  accounts.patch("/:accountId/settings", guard, async (req, res) => {
    const body = (req.body ?? {}) as { autoReview?: unknown; timezone?: unknown };
    const hasReview = typeof body.autoReview === "boolean";
    const hasZone = typeof body.timezone === "string" && body.timezone.trim().length > 0;
    if (!hasReview && !hasZone) {
      res.status(400).json({ error: "autoReview must be a boolean." });
      return;
    }
    if (hasZone && !isTimeZone(body.timezone as string)) {
      res.status(400).json({ error: "timezone must be a zone name such as Asia/Riyadh." });
      return;
    }
    const accountId = pathParam(req, "accountId");
    if (hasReview) {
      const updated = await setAutoReview(ctx.db, accountId, body.autoReview as boolean);
      if (!updated) {
        res.status(404).json({ error: "Account not found." });
        return;
      }
    }
    const settings = hasZone
      ? await rememberTimezone(ctx.db, accountId, (body.timezone as string).trim())
      : await getAccountSettings(ctx.db, accountId);
    if (!settings) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json(settings);
  });
  accounts.get("/:accountId/tool-approvals", guard, async (req, res) => {
    res.json(await listToolApprovals(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/tool-approvals/:approvalId/approve", guard, async (req, res) => {
    await decideToolApprovalHttp(ctx, pathParam(req, "accountId"), pathParam(req, "approvalId"), "approved", res);
  });
  accounts.post("/:accountId/tool-approvals/:approvalId/deny", guard, async (req, res) => {
    await decideToolApprovalHttp(ctx, pathParam(req, "accountId"), pathParam(req, "approvalId"), "denied", res);
  });
  accounts.post("/:accountId/screens/:profile/takeover", guard, (req, res) => setScreen(ctx.db, req, res, "takeover"));
  accounts.post("/:accountId/screens/:profile/handback", guard, (req, res) => setScreen(ctx.db, req, res, "handback"));
  accounts.get("/:accountId/screens/:profile/ws-token", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    const profile = decodeURIComponent(pathParam(req, "profile"));
    if (!(await profileOnAccount(ctx.db, accountId, profile))) {
      res.status(404).json({ error: "Screen not found." });
      return;
    }
    res.json({ token: mintScreenToken(accountId, profile, screenTokenKey()) });
  });
  accounts.get("/:accountId/screens/:profile/client", novncClientPage);
  accounts.post("/:accountId/uploads", guard, async (req, res) => {
    // Scoped under the account so requireSession can match the session's
    // accountId. A standalone /uploads route has no account context and can
    // only 403 — that was the "account is not available" bug on attach.
    // Minimal URL-accepting upload: the phone sends an https URL or a data:
    // URI (images, text, pdf, json) from the picker. Why no disk writes:
    // binary blobs belong in object storage (S3 seam); rows store the URL,
    // not bytes, keeping Postgres small and prompts bounded. data: URIs are
    // mime-allowlisted so the row cannot smuggle executables.
    const { url, name, mime } = req.body ?? {};
    if (typeof url !== "string" || url.length === 0 || url.length > 8_000_000) {
      res.status(400).json({ error: "url is required (https or data: base64, <=8MB)." });
      return;
    }
    const ok =
      url.startsWith("data:image/") ||
      /^data:(text\/[a-z0-9.+-]+|application\/(pdf|json));base64,/.test(url) ||
      (() => {
        try {
          return new URL(url).protocol === "https:";
        } catch {
          return false;
        }
      })();
    if (!ok) {
      res.status(400).json({ error: "Only https URLs or image/text/pdf/json data URIs are accepted." });
      return;
    }
    res.status(201).json({ url, name: typeof name === "string" ? name : "upload", mime: typeof mime === "string" ? mime : null });
  });
  return accounts;
}

/**
 * Pauses or resumes one profile's pointer.
 * Input: the database, the request, the response, and takeover or handback.
 * Output: nothing. A profile outside the account is a 404.
 */
async function setScreen(db: Database, req: Request, res: Response, action: "takeover" | "handback"): Promise<void> {
  const accountId = pathParam(req, "accountId");
  const profile = pathParam(req, "profile");
  const owned = await profileOnAccount(db, accountId, profile);
  if (!owned) {
    res.status(404).json({ error: "Screen not found." });
    return;
  }
  if (action === "takeover") {
    takeOver(accountId, profile);
  } else {
    handBack(accountId, profile);
  }
  res.json({ ok: true });
}
