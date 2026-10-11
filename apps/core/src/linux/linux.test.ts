import { afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import Dockerode from "dockerode";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { startServer } from "../http/server.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { accountHome, accountShared, createLinux, createProfile, exec, removeAccountContainers } from "./linux.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("linux", () => {
  afterAll(async () => {
    await removeAccountContainers({ testOnly: true });
    await db.$client.end();
  });

  it("gives each account its own Linux", async () => {
    const first = await createAccount(db, { name: "One" });
    const second = await createAccount(db, { name: "Two" });
    const write = await exec(first.id, ["sh", "-c", `echo secret > ${accountShared(first.id)}/only-first`]);
    expect(write.code).toBe(0);
    const absent = await exec(second.id, ["sh", "-c", `test ! -f ${accountShared(second.id)}/only-first`]);
    expect(absent.code).toBe(0);
  });

  it("keeps homes private and shares /shared", async () => {
    const account = await createAccount(db, { name: "Profiles" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const bea = await createAgent(db, account.id, hired("Bea"));
    const adaUser = await createProfile(db, account.id, ada.id);
    const beaUser = await createProfile(db, account.id, bea.id);
    expect(adaUser).not.toBe(beaUser);

    const homeMode = await exec(account.id, ["stat", "-c", "%a", accountHome(account.id, adaUser)]);
    expect(homeMode.stdout.trim()).toBe("700");
    await exec(account.id, ["sh", "-c", `echo secret > ${accountHome(account.id, adaUser)}/secret`], adaUser);
    await exec(account.id, ["sh", "-c", `echo hello > ${accountShared(account.id)}/note && chmod a+r ${accountShared(account.id)}/note`], adaUser);
    const shared = await exec(account.id, ["cat", `${accountShared(account.id)}/note`], beaUser);
    expect(shared.stdout.trim()).toBe("hello");
    const hidden = await exec(account.id, ["cat", `${accountHome(account.id, adaUser)}/secret`], beaUser);
    expect(hidden.code).not.toBe(0);
  });

  it("provisions the standard toolchain and container-local admin access before desktop use", async () => {
    const account = await createAccount(db, { name: "Toolchain" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const profile = await createProfile(db, account.id, ada.id);

    const tools = await exec(
      account.id,
      ["sh", "-c", "command -v node && command -v npm && command -v python3 && python3 -m pip --version"],
      profile,
    );
    expect(tools.code).toBe(0);

    const admin = await exec(account.id, ["sudo", "-n", "id", "-u"], profile);
    expect(admin.code).toBe(0);
    expect(admin.stdout.trim()).toBe("0");
  });

  it("creates one profile per member when a group is opened", async () => {    const account = await createAccount(db, { name: "Group" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const bea = await createAgent(db, account.id, hired("Bea"));
    const server = await startServer(db, 0, undefined, { openAccess: true });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/accounts/${account.id}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "group",
        title: "desk",
        ownerAgentId: ada.id,
        memberAgentIds: [ada.id, bea.id],
      }),
    });
    expect(response.status).toBe(201);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    const rows = await db.select().from(agents).where(eq(agents.accountId, account.id));
    expect(rows.map((row) => row.linuxProfile).every((profile) => profile !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.linuxProfile)).size).toBe(2);
  });

  it("closes the network to this machine and to other accounts, and keeps the internet", async () => {
    const docker = new Dockerode({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
    const first = await createAccount(db, { name: "Fenced" });
    const second = await createAccount(db, { name: "Neighbour" });
    const neighbour = await docker.getContainer(`nano-${second.id}`).inspect();
    const bridge = Object.values(neighbour.NetworkSettings.Networks)[0];
    const connect = (accountId: string, host: string, port: number) =>
      exec(accountId, ["bash", "-c", `timeout 4 bash -c '</dev/tcp/${host}/${port}'`]);

    // The neighbour listens on its bridge address and can reach itself there.
    await exec(second.id, ["sh", "-c", "nohup nc -lk -p 8099 >/dev/null 2>&1 &"]);
    await expect.poll(async () => (await connect(second.id, bridge.IPAddress, 8099)).code).toBe(0);

    expect((await connect(first.id, bridge.IPAddress, 8099)).code).not.toBe(0);
    // The test database listens on this machine; the bridge gateway is this machine.
    expect((await connect(first.id, bridge.Gateway, 5432)).code).not.toBe(0);
    expect((await connect(first.id, "169.254.169.254", 80)).code).not.toBe(0);

    // Root inside the container cannot take the rules out.
    expect((await exec(first.id, ["iptables", "-F"])).code).not.toBe(0);

    const internet = await exec(first.id, ["curl", "-sS", "-o", "/dev/null", "--max-time", "20", "https://example.com"]);
    expect(internet.stdout).toBe("");
    expect(internet.code).toBe(0);
  }, 60_000);

  it("keeps exactly one container per account across repeated and concurrent calls", async () => {
    const docker = new Dockerode({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
    const account = await createAccount(db, { name: "Single" });
    // Sequential repeats plus a concurrent burst must all resolve to the
    // same container instead of 409ing or duplicating it.
    const ids = await Promise.all([createLinux(account.id), createLinux(account.id), createLinux(account.id)]);
    expect(new Set(ids).size).toBe(1);
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`nano.account=${account.id}`] },
    });
    expect(listed).toHaveLength(1);
  });

  it("labels test computers and spares unlabeled ones on scoped cleanup", async () => {
    const docker = new Dockerode({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
    const account = await createAccount(db, { name: "Labeled" });
    const info = await docker.getContainer(`nano-${account.id}`).inspect();
    expect(info.Config.Labels["nano.test"]).toBe("1");
    // An unlabeled stand-in for the developer's real computer: scoped cleanup
    // must leave it alone while removing the test one.
    const spare = await docker.createContainer({
      name: "nano-spare-check",
      Image: "kuru-linux:1",
      Labels: { "nano.account": "spare" },
    });
    await removeAccountContainers({ testOnly: true });
    const survivors = await docker.listContainers({
      all: true,
      filters: { label: [`nano.account=${account.id}`] },
    });
    expect(survivors).toHaveLength(0);
    const spareAlive = await docker.listContainers({
      all: true,
      filters: { label: ["nano.account=spare"] },
    });
    expect(spareAlive).toHaveLength(1);
    await spare.remove({ force: true });
  });
});

function hired(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
