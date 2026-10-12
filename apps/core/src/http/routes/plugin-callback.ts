import { Router } from "express";
import { finishGoogleOAuth } from "../../mcp/google-oauth.js";
import { finishMcpOAuth } from "../../mcp/mcp-oauth.js";
import { peekPending } from "../../mcp/oauth-pending.js";
import { finishSocialOAuth } from "../../social/accounts.js";
import { openFile, readFileLink } from "../../social/files.js";
import { fileSize } from "../../rooms/uploads.js";
import type { AppContext } from "../context.js";

/**
 * The page an OAuth provider sends the browser back to after plugin consent.
 * Why no session guard: the browser arrives from another site without the
 * app's session. The unguessable state id from the start call names the account.
 * Input: the request context. Output: the router.
 */
export function pluginCallbackRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get("/plugins/oauth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";
    if (oauthError || !code || !state) {
      res.status(400).type("html").send(pluginPage("The plugin was not connected."));
      return;
    }
    try {
      const pending = peekPending(state);
      if (!pending) throw new Error("This plugin sign-in expired. Start it again.");
      const name =
        pending.kind === "google"
          ? (await finishGoogleOAuth(ctx.db, state, code)).name
          : pending.kind === "mcp"
            ? (await finishMcpOAuth(ctx.db, state, code)).slug
            : (await finishSocialOAuth(ctx.db, state, code)).name;
      res.type("html").send(pluginPage(`${name} is connected. You can close this window.`));
    } catch (error) {
      res.status(400).type("html").send(pluginPage(error instanceof Error ? error.message : "The plugin was not connected."));
    }
  });
  /**
   * One file from an account's computer, for Instagram or TikTok to download.
   * Why no session guard: the caller is the platform's server. The signed
   * link names the account, the Linux user and the exact path, and runs out
   * in two hours, so it opens that one file and nothing else.
   */
  router.get("/social/file/:token/:name", async (req, res) => {
    const link = readFileLink(String(req.params.token ?? ""));
    const size = link ? await fileSize(link.accountId, link.path, link.profile).catch(() => null) : null;
    if (!link || size === null) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const name = link.path.split("/").pop() ?? "file";
    const extension = (name.split(".").pop() ?? "").toLowerCase();
    const types: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start > end || start >= size) {
        res.status(416).set("Content-Range", `bytes */${size}`).end();
        return;
      }
    }
    const length = end - start + 1;
    res.status(range ? 206 : 200).set({
      "Content-Type": types[extension] ?? "application/octet-stream",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const opened = await openFile({ accountId: link.accountId, profile: link.profile, path: link.path, name, size, mime: "", extension }, start, length);
    res.on("close", opened.stop);
    opened.stream.pipe(res);
  });
  return router;
}

function pluginPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugin</title><body style="font-family:sans-serif;padding:24px"><p>${safe}</p><script>location.href=${JSON.stringify("nano-agents://plugins")}</script>`;
}
