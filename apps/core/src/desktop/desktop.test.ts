import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import { getDb } from "../db/client.js";
import { startServer } from "../http/server.js";
import { createAgent, createAccount } from "../roster/roster.js";
import { createProfile, removeAccountContainers } from "../linux/linux.js";
import { mouse, screenshot, startDesktop } from "./desktop.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

afterAll(async () => {
  await removeAccountContainers({ testOnly: true });
  await db.$client.end();
});

test("a pointer move changes the screenshot", async () => {
  const account = await createAccount(db, { name: "Screen" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const profile = await createProfile(db, account.id, ada.id);
  await startDesktop(account.id, profile);
  const before = await screenshot(account.id, profile);
  await mouse(account.id, profile, 200, 80);
  const after = await screenshot(account.id, profile);
  expect(Buffer.compare(before, after)).not.toBe(0);
});

test("the core proxies the screen and takeover pauses the pointer", async () => {
  const account = await createAccount(db, { name: "Watch" });
  const other = await createAccount(db, { name: "Other" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const profile = await createProfile(db, account.id, ada.id);
  const server = await startServer(db, 0, undefined, { openAccess: true });
  const address = server.address() as AddressInfo;
  const denied = await fetch(`http://127.0.0.1:${address.port}/accounts/${other.id}/screens/${profile}/takeover`, {
    method: "POST",
  });
  expect(denied.status).toBe(404);
  const screen = await openScreen(`ws://127.0.0.1:${address.port}/accounts/${account.id}/screens/${profile}`);
  await framebuffer(screen);
  const taken = await fetch(`http://127.0.0.1:${address.port}/accounts/${account.id}/screens/${profile}/takeover`, {
    method: "POST",
  });
  expect(taken.status).toBe(200);
  await expect(mouse(account.id, profile, 40, 40)).rejects.toThrow(/pointer/);
  const returned = await fetch(`http://127.0.0.1:${address.port}/accounts/${account.id}/screens/${profile}/handback`, {
    method: "POST",
  });
  expect(returned.status).toBe(200);
  await mouse(account.id, profile, 180, 40);
  screen.ws.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}, 20000);

class Bytes {
  private buf = Buffer.alloc(0);
  private waiting: ((value: Buffer) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private need = 0;

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.flush();
  }

  read(n: number): Promise<Buffer> {
    this.need = n;
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
      this.flush();
    });
  }

  fail(error: Error): void {
    this.failed?.(error);
  }

  private flush(): void {
    if (!this.waiting || this.buf.length < this.need) {
      return;
    }
    const out = Buffer.from(this.buf.subarray(0, this.need));
    this.buf = Buffer.from(this.buf.subarray(this.need));
    const resolve = this.waiting;
    this.waiting = null;
    this.failed = null;
    resolve(out);
  }
}

function openScreen(url: string): Promise<{ ws: WebSocket; bytes: Bytes }> {
  const ws = new WebSocket(url);
  const bytes = new Bytes();
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    const data = event.data;
    const buf =
      typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer));
    bytes.push(buf);
  });
  ws.addEventListener("close", () => bytes.fail(new Error("The screen socket closed.")));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, bytes }));
    ws.addEventListener("error", () => reject(new Error("The screen socket failed.")));
  });
}

async function framebuffer(screen: { ws: WebSocket; bytes: Bytes }): Promise<void> {
  const version = await screen.bytes.read(12);
  expect(version.toString("ascii")).toMatch(/^RFB /);
  screen.ws.send(Buffer.from("RFB 003.008\n"));
  const count = (await screen.bytes.read(1))[0] ?? 0;
  const types = await screen.bytes.read(count);
  expect([...types]).toContain(1);
  screen.ws.send(Buffer.from([1]));
  expect((await screen.bytes.read(4)).readUInt32BE(0)).toBe(0);
  screen.ws.send(Buffer.from([1]));
  const init = await screen.bytes.read(24);
  const nameLength = init.readUInt32BE(20);
  if (nameLength > 0) {
    await screen.bytes.read(nameLength);
  }
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(init.readUInt16BE(0), 6);
  request.writeUInt16BE(init.readUInt16BE(2), 8);
  screen.ws.send(request);
  expect((await screen.bytes.read(4))[0]).toBe(0);
}

function hired(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} uses the desktop.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
