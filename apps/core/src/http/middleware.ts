import type { IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { localBrowserOrigins } from "../auth/auth.js";
import { config } from "../config.js";
import { RoomCapacityError } from "../rooms/rooms.js";
import { AgentNameError, MissingProviderKeyError, ProtectedAgentError } from "../roster/roster.js";
import { logger, type Guard } from "./context.js";

export const AUTH_REQUESTS_PER_MINUTE = 60;
export const WRITE_REQUESTS_PER_MINUTE = 300;
const SMALL_BODY = "256kb";
const LARGE_BODY = "12mb";

/** Routes whose body may carry an attachment or an avatar as a data: URI. */
const LARGE_BODY_ROUTES = [
  /^\/conversations\/[^/]+\/messages\/?$/,
  /^\/accounts\/[^/]+\/uploads\/?$/,
  /^\/agents\/[^/]+\/?$/,
];

/**
 * Caps how many requests one client address may make per minute.
 * Input: the cap. Output: middleware that answers 429 past it.
 */
export function requestLimit(perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Try again in a minute." },
  });
}

/** The same cap, applied to requests that change something. Reads stay uncounted. */
export function writeLimit(perMinute: number) {
  const limiter = requestLimit(perMinute);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    void limiter(req, res, next);
  };
}

/**
 * Parses a JSON body, with a small cap everywhere except attachment routes.
 * Why: one message can carry phone attachments as data: URIs up to 8MB, so
 * those routes need a 12MB body. Reading that much for any caller let anyone
 * make the server buffer it, so the large cap is only reached after the
 * session check has passed.
 * Input: the session guard. Output: middleware that fills req.body.
 */
export function jsonBody(guard: Guard) {
  const small = express.json({ limit: SMALL_BODY, type: acceptsJson });
  const large = express.json({ limit: LARGE_BODY, type: acceptsJson });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD" || !LARGE_BODY_ROUTES.some((route) => route.test(req.path))) {
      small(req, res, next);
      return;
    }
    void guard(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      large(req, res, next);
    }).catch(next);
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  next();
}

export function localCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && localBrowserOrigins().includes(origin)) {
    const requested = req.headers["access-control-request-headers"];
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", Array.isArray(requested) ? requested.join(", ") : (requested ?? "content-type"));
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
  }
  next();
}

export function onError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }
  if (
    error instanceof RoomCapacityError ||
    error instanceof AgentNameError ||
    error instanceof ProtectedAgentError ||
    error instanceof MissingProviderKeyError
  ) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.name === "ZodError") {
    res.status(400).json({ error: error.message });
    return;
  }
  const status = clientStatus(error);
  if (status === 413) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }
  if (status !== undefined) {
    const parseFailed = typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed";
    const message = error instanceof Error && error.message ? error.message : "Request failed.";
    res.status(status).json({ error: parseFailed ? "Request body must be JSON." : message });
    return;
  }
  logger.error({ err: error }, "request failed");
  const message = config.isProduction() || !(error instanceof Error) ? "Request failed." : error.message;
  res.status(500).json({ error: message });
}

function acceptsJson(req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return false;
  }
  const header = req.headers["content-type"];
  if (typeof header !== "string" || header.length === 0) {
    return true;
  }
  const type = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

function clientStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  if (typeof status !== "number" || status < 400 || status >= 500) {
    return undefined;
  }
  return status;
}
