import { afterAll, expect, test } from "vitest";
import { getDb } from "../db/client.js";
import { createAgent, createAccount } from "../roster/roster.js";
import { accountHome, accountShared, createProfile, removeAccountContainers } from "../linux/linux.js";
import { bash, readFile, writeFile } from "./computer.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

afterAll(async () => {
  await removeAccountContainers({ testOnly: true });
  await db.$client.end();
});

test("shares a file and refuses another home", async () => {
  const account = await createAccount(db, { name: "Desk" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const bea = await createAgent(db, account.id, hired("Bea"));
  const adaUser = await createProfile(db, account.id, ada.id);
  const beaUser = await createProfile(db, account.id, bea.id);
  await writeFile(account.id, adaUser, `${accountShared(account.id)}/note`, "hello");
  await expect(readFile(account.id, beaUser, `${accountShared(account.id)}/note`)).resolves.toBe("hello");
  await writeFile(account.id, adaUser, `${accountHome(account.id, adaUser)}/secret`, "private");
  await expect(readFile(account.id, beaUser, `${accountHome(account.id, adaUser)}/secret`)).rejects.toThrow(/outside/);
  await expect(bash(account.id, beaUser, "whoami")).resolves.toBe(`${beaUser}\n`);
});

function hired(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} writes files.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
