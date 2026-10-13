import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webApp } from "./web-app.js";

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("web app routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-app-"));
    mkdirSync(join(dir, "_expo", "static", "js", "web"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Kuru</title>");
    writeFileSync(join(dir, "_expo", "static", "js", "web", "entry-abc.js"), "console.log(1)");
    const app = express();
    app.use(webApp(dir));
    app.use((_req, res) => res.status(404).json({ error: "Not found." }));
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("serves the page at /app and for every route inside the app", async () => {
    for (const path of ["/app", "/app/", "/app/chat/123"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("<title>Kuru</title>");
    }
  });

  it("serves built files and lets the browser keep them", async () => {
    const response = await fetch(`${baseUrl}/app/_expo/static/js/web/entry-abc.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("answers a missing file with 404, not with the page", async () => {
    const response = await fetch(`${baseUrl}/app/_expo/static/js/web/gone.js`);
    expect(response.status).toBe(404);
  });

  it("leaves every other address to the rest of the server", async () => {
    const response = await fetch(`${baseUrl}/accounts/1/agents`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });
});

describe("web app routes with nothing built", () => {
  it("says the app is not built", async () => {
    const app = express();
    app.use(webApp(join(tmpdir(), "no-such-web-app")));
    const { server, baseUrl } = await listen(app);
    const response = await fetch(`${baseUrl}/app`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("not built");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
