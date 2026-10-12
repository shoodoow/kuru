import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { startServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const previous = {
  nodeEnv: process.env.NODE_ENV,
  googleId: process.env.GOOGLE_CLIENT_ID,
  googleSecret: process.env.GOOGLE_CLIENT_SECRET,
  authUrl: process.env.BETTER_AUTH_URL,
  authSecret: process.env.BETTER_AUTH_SECRET,
};

beforeAll(async () => {
  process.env.NODE_ENV = "production";
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.BETTER_AUTH_URL = "https://example.test";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-thirty-two-characters";
  const server = await startServer(db, 0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

afterAll(async () => {
  await closeServer?.();
  await db.$client.end();
  restore("NODE_ENV", previous.nodeEnv);
  restore("GOOGLE_CLIENT_ID", previous.googleId);
  restore("GOOGLE_CLIENT_SECRET", previous.googleSecret);
  restore("BETTER_AUTH_URL", previous.authUrl);
  restore("BETTER_AUTH_SECRET", previous.authSecret);
});

it("does not allow the Expo web origin in production", async () => {
  const response = await fetch(`${baseUrl}/api/auth/get-session`, {
    headers: { origin: "http://127.0.0.1:8081" },
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

it("rejects an account API request without a signed session", async () => {
  const response = await fetch(`${baseUrl}/accounts/00000000-0000-4000-8000-000000000000/agents`);
  expect(response.status).toBe(401);
});

it("does not expose the old unauthenticated account creation route", async () => {
  const response = await fetch(`${baseUrl}/accounts`, {
    method: "POST",
    body: JSON.stringify({ name: "Untrusted" }),
  });
  expect(response.status).toBe(404);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
