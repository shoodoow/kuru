import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fromNodeHeaders } from "better-auth/node";
import { profileOnAccount, startDesktop } from "../desktop/desktop.js";
import { signingKey } from "../keys/keys.js";
import { screenOpened } from "../computer/housekeeping.js";
import { pipeExec } from "../linux/linux.js";
import { logger, type Auth, type Database } from "./context.js";
import { verifyScreenToken } from "./screen-token.js";

/**
 * Proxies one profile's noVNC connection through the core.
 * Input: the database, the upgrade request, the client socket, and bytes already read.
 * Output: nothing. The client talks to that profile's desktop and never receives the container port.
 */
export async function proxyScreen(
  db: Database,
  auth: Auth,
  openAccess: boolean,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(/^\/accounts\/([^/]+)\/screens\/([^/]+)$/);
  if (!match) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accountId = match[1] ?? "";
  const profile = decodeURIComponent(match[2] ?? "");
  if (!openAccess) {
    const token = url.searchParams.get("token");
    const tokenOk =
      token != null &&
      (() => {
        const payload = verifyScreenToken(token, screenTokenKey());
        return payload?.accountId === accountId && payload.profile === profile;
      })();
    if (!tokenOk) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      const sessionAccountId = String((session?.user as { accountId?: string | null } | undefined)?.accountId ?? "");
      if (!session || sessionAccountId !== accountId) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
    }
  }
  const owned = await profileOnAccount(db, accountId, profile);
  if (!owned) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const session = await startDesktop(accountId, profile);
  const lines = ["GET / HTTP/1.1", `Host: 127.0.0.1:${session.novncPort}`];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name.toLowerCase() === "host") {
      continue;
    }
    lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  const preamble = Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]);
  logger.info({ accountId, profile }, "screen proxy opened");
  // While the person is looking at this screen its browser is not closed for being idle.
  const closed = screenOpened(accountId, profile);
  socket.once("close", closed);
  try {
    await pipeExec(accountId, ["socat", "STDIO", `TCP:127.0.0.1:${session.novncPort}`], socket, preamble);
  } catch (error) {
    closed();
    throw error;
  }
}

/** The key that signs the short-lived tokens a phone uses to open a screen socket. */
export function screenTokenKey(): Buffer {
  return signingKey("nano-screen-token");
}
