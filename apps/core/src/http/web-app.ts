import { Router, type Request, type Response } from "express";
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the web app lives on the server's own address. */
export const WEB_APP_PATH = "/app";

/**
 * The folder holding the built web app (`pnpm --filter mobile build:web`).
 * WEB_APP_DIR names it; otherwise it is apps/mobile/dist-web in this
 * repository, found from this file's own place so it is the same in
 * development and in the Docker image.
 */
function webAppDir(): string {
  const named = process.env.WEB_APP_DIR?.trim();
  if (named) return resolve(named);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../mobile/dist-web");
}

/**
 * Serves the web and desktop app from the server's own address, at /app.
 * Why here and not on a host of its own: the app signs in with a cookie. A
 * page on another address would need the server to accept cross-site cookies
 * and requests from it. Served from the same address, the browser treats the
 * app and the API as one site and none of that is needed.
 * The files are the app's code and pictures, the same for everyone, so they
 * need no session. Every route inside the app answers with the one page, and
 * the app decides what to show.
 * Input: an optional folder, for tests. Output: a router to mount on the app.
 */
export function webApp(dir: string = webAppDir()): Router {
  const router = Router();
  const index = join(dir, "index.html");
  if (!existsSync(index)) {
    router.get([WEB_APP_PATH, `${WEB_APP_PATH}/*splat`], (_req: Request, res: Response) => {
      res.status(404).json({ error: "The web app is not built on this server. Run: pnpm --filter mobile build:web" });
    });
    return router;
  }
  router.use(
    WEB_APP_PATH,
    express.static(dir, {
      index: false,
      dotfiles: "deny",
      redirect: false,
      fallthrough: true,
      setHeaders: (res, file) => {
        // Built files carry a hash of their content in their name, so a browser may keep them for good.
        if (file.includes(`${join("_expo", "static")}`) || file.includes(`${join(dir, "assets")}`)) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  router.get([WEB_APP_PATH, `${WEB_APP_PATH}/*splat`], (req: Request, res: Response) => {
    // A missing script or picture is a 404, not the page: answering it with
    // HTML makes a stale tab fail in ways nobody can read.
    if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.sendFile(index);
  });
  return router;
}
