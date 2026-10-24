import { afterAll, expect, test } from "vitest";
import { getDb } from "../db/client.js";
import { createAgent, createAccount } from "../roster/roster.js";
import { accountHome, accountShared, createProfile, removeAccountContainers } from "../linux/linux.js";
import { bash, readFile, writeFile } from "./computer.js";
import { linuxToolExecutes } from "./linux-tool-executes.js";

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

test("code tools read a page, edit in place and apply a patch on the computer, /tmp included", async () => {
  const account = await createAccount(db, { name: "Code desk" });
  const ada = await createAgent(db, account.id, hired("Ada"));
  const user = await createProfile(db, account.id, ada.id);
  const tools = linuxToolExecutes(db, account.id, user);
  const home = accountHome(account.id, user);
  const scene = Array.from({ length: 2_500 }, (_, index) => `step(${index + 1});`).join("\n");
  await writeFile(account.id, user, `${home}/scene/film.js`, `import { drawGarden } from './machine.js';\n${scene}\n`);

  const first = String(await tools.read!({ path: "~/scene/film.js" }));
  expect(first).toMatch(/^1: import \{ drawGarden \}/);
  expect(first).toContain("[Lines 1-2000 of 2501. Read on with offset: 2001.]");
  expect(String(await tools.read!({ path: "~/scene/film.js", offset: 2501 }))).toBe("2501: step(2500);");

  const edited = String(await tools.edit!({ path: "~/scene/film.js", oldString: "import { drawGarden }", newString: "import { drawWalk }" }));
  expect(edited).toContain("Changed 1 place");
  expect(edited).toContain("1: import { drawWalk } from './machine.js';");
  await expect(tools.edit!({ path: "~/scene/film.js", oldString: "missing()", newString: "x" })).rejects.toThrow(/not found/);

  const patched = String(
    await tools.apply_patch!({
      patch: [
        "*** Begin Patch",
        "*** Add File: ~/scene/notes/plan.md",
        "+render, then mux",
        "*** Update File: ~/scene/film.js",
        "*** Move to: ~/scene/main.js",
        "-step(2500);",
        "+done();",
        "*** End Patch",
      ].join("\n"),
    }),
  );
  expect(patched).toContain("A ~/scene/notes/plan.md");
  expect(patched).toContain("R ~/scene/film.js -> ~/scene/main.js");
  await expect(readFile(account.id, user, `${home}/scene/notes/plan.md`)).resolves.toBe("render, then mux\n");
  await expect(readFile(account.id, user, `${home}/scene/main.js`)).resolves.toMatch(/drawWalk[\s\S]*step\(2499\);\ndone\(\);\n$/);
  await expect(readFile(account.id, user, `${home}/scene/film.js`)).rejects.toThrow();

  await tools.write!({ path: "/tmp/kuru-code-test/a.js", body: "let a = 1;\n" });
  await tools.edit!({ path: "/tmp/kuru-code-test/a.js", oldString: "let a = 1;", newString: "let a = 2;" });
  await expect(readFile(account.id, user, "/tmp/kuru-code-test/a.js")).resolves.toBe("let a = 2;\n");

  // A command starts in the agent's home, as a terminal does.
  await expect(tools.bash!({ command: "pwd" })).resolves.toMatch(new RegExp(`^${home}\n`));
  // A worker's shell output is not cut at a few thousand characters any more.
  expect(String(await tools.bash!({ command: "seq 1 5000" })).length).toBeGreaterThan(20_000);
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
