import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { KURU_VERSION, MIN_APP_VERSION } from "@kuru/shared";
import { toNodeHandler } from "better-auth/node";
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { createAuth } from "../auth/auth.js";
import { config } from "../config.js";
import { createAccount, ensureSupportAgentQuietly } from "../roster/roster.js";
import { logger, requireSession, type AppContext, type Database, type Generate } from "./context.js";
import {
  AUTH_REQUESTS_PER_MINUTE,
  WRITE_REQUESTS_PER_MINUTE,
  jsonBody,
  localCors,
  onError,
  requestLimit,
  securityHeaders,
  writeLimit,
} from "./middleware.js";
import { accountsRoutes } from "./routes/accounts.js";
import { agentsRoutes } from "./routes/agents.js";
import { conversationsRoutes } from "./routes/conversations.js";
import { devicesRoutes } from "./routes/devices.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { pluginCallbackRoutes } from "./routes/plugin-callback.js";
import { proposalsRoutes } from "./routes/proposals.js";
import { novncAssets } from "./screen-client.js";
import { proxyScreen } from "./screen-proxy.js";

export type ServerOptions = {
  /**
   * Skips the session check and opens account creation, for fixtures that call
   * the API directly. Only a server bound to this machine may use it.
   */
  openAccess?: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Live fanout lives in rooms/stream.ts (shared with the scheduler); the
// durable twin is the events table, replayed by cursor in routes/conversations.ts.

/**
 * Starts the core HTTP server.
 * Input: a database client, a port, an optional model call, and options. Port 0 asks the operating system for a free port.
 * Output: the listening server. Close it when the process should stop.
 */
export function startServer(db: Database, port: number, generate?: Generate, options: ServerOptions = {}): Promise<Server> {
  const host = config.host();
  const openAccess = options.openAccess === true;
  if (openAccess && !LOOPBACK_HOSTS.has(host)) {
    throw new Error("A server without sign-in can only listen on this machine. Set HOST=127.0.0.1.");
  }
  const auth = createAuth(db);
  const app = createApp({ db, auth, generate, openAccess });
  const server = createServer(app);
  server.on("upgrade", (request, socket, head) => {
    proxyScreen(db, auth, openAccess, request, socket, head).catch((error: unknown) => {
      logger.error({ err: error }, "screen proxy failed");
      socket.destroy();
    });
  });
  return new Promise<Server>((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      logger.info({ host, port: typeof address === "object" && address ? address.port : port }, "core listening");
      resolve(server);
    });
  });
}

/**
 * Builds the Express application.
 * Input: the database, auth instance, and optional model call.
 * Output: the app. Auth is mounted before the JSON parser so Better Auth can read the raw body.
 */
function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", config.trustProxy());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url?.split("?")[0] === "/health" },
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) {
          return "error";
        }
        if (res.statusCode >= 400) {
          return "warn";
        }
        return "info";
      },
    }),
  );
  app.use(securityHeaders);
  app.use(localCors);

  if (!ctx.openAccess) {
    app.use("/api/auth", requestLimit(AUTH_REQUESTS_PER_MINUTE));
    app.use(writeLimit(WRITE_REQUESTS_PER_MINUTE));
  }

  const authHandler = toNodeHandler(ctx.auth);
  app.all("/api/auth/*splat", (req, res, next) => {
    Promise.resolve(authHandler(req, res)).catch(next);
  });

  app.use(jsonBody(requireSession(ctx)));
  // Also says which release this is, so an app can tell when one side needs updating.
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, version: KURU_VERSION, minAppVersion: MIN_APP_VERSION });
  });
  mountRoutes(app, ctx);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use(onError);
  return app;
}

/**
 * Mounts every route group.
 * Input: the Express app and the request context.
 * Output: nothing. Each route checks the signed-in account except account
 * creation, which exists only on a fixture server.
 */
function mountRoutes(app: Express, ctx: AppContext): void {
  const guard = requireSession(ctx);

  if (ctx.openAccess) {
    app.post("/accounts", async (req, res) => {
      const account = await createAccount(ctx.db, req.body);
      await ensureSupportAgentQuietly(ctx.db, account.id, ctx.generate);
      res.status(201).json(account);
    });
  }

  app.use("/accounts", accountsRoutes(ctx, guard));
  app.use(pluginCallbackRoutes(ctx));
  app.use(novncAssets());
  app.use("/conversations", conversationsRoutes(ctx, guard));
  app.use("/proposals", proposalsRoutes(ctx, guard));
  app.use("/agents", agentsRoutes(ctx, guard));
  app.use("/devices", devicesRoutes(ctx, guard));
  app.use("/notifications", notificationsRoutes(ctx, guard));
}
