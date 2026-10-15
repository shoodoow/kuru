import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { exec, removeAccountContainers } from "../linux/linux.js";
import { createAccount } from "../roster/roster.js";
import { publishHostSkills, readLocalSkill, sharedSkillsRoot, writeSharedSkill } from "./local.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);
let root = "";

describe("server skills on the account computer", () => {
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    await removeAccountContainers({ testOnly: true });
    await db.$client.end();
  });

  it("copies a skill's scripts and templates, not only its text, and puts the product's copy over one of the same name", async () => {
    root = await mkdtemp(join(tmpdir(), "kuru-server-skills-"));
    await mkdir(join(root, "reel", "scripts"), { recursive: true });
    await mkdir(join(root, "reel", "node_modules", "big"), { recursive: true });
    await writeFile(join(root, "reel", "SKILL.md"), "---\nname: reel\ndescription: Reels.\n---\n\nRun scripts/new.sh.\n");
    await writeFile(join(root, "reel", "scripts", "new.sh"), "echo made\n");
    await writeFile(join(root, "reel", "node_modules", "big", "index.js"), "x\n");
    await mkdir(join(root, "mine"), { recursive: true });
    await writeFile(join(root, "mine", "SKILL.md"), "---\nname: mine\ndescription: Server copy.\n---\n\nServer body.\n");

    const account = await createAccount(db, { name: "Skills" });
    await writeSharedSkill(account.id, "---\nname: mine\ndescription: Account copy.\n---\n\nAccount body.\n");
    await publishHostSkills(root, account.id);

    const shared = sharedSkillsRoot(account.id);
    const ran = await exec(account.id, ["sh", "-c", `sh ${shared}/reel/scripts/new.sh && test ! -e ${shared}/reel/node_modules`]);
    expect(ran.stdout.trim()).toBe("made");
    expect(ran.code).toBe(0);
    const body = await readLocalSkill(account.id, "root", "reel");
    expect(body).toContain(`Skill directory: ${shared}/reel`);
    // The product's skill wins over an install of the same name: a router of the same name had displaced ours.
    expect(await readLocalSkill(account.id, "root", "mine")).toContain("Server body.");

  });
});
