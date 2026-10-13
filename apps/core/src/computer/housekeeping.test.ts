import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { delegations } from "../db/schema.js";
import { createProfile, removeAccountContainers } from "../linux/linux.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { ensureBrowser, runBrowserTool } from "./browser-bridge.js";
import { browsersOpen, closeIdleBrowsers, closeIdleDesktops, desktopsOpen, screenOpened } from "./housekeeping.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);
const hired = (name: string) => ({ name, label: name, role: "Teammate", jobDescription: `${name} works here.`, provider: "openai", modelId: "gpt-5" });

describe("browser housekeeping", () => {
  afterAll(async () => {
    await removeAccountContainers({ testOnly: true });
    await db.$client.end();
  });

  it("closes an idle browser, leaves one that is watched or working, and the browser comes back on the next call", async () => {
    const account = await createAccount(db, { name: "Housekeeping" });
    const ada = await createAgent(db, account.id, hired("Ada"));
    const bea = await createAgent(db, account.id, hired("Bea"));
    const cy = await createAgent(db, account.id, hired("Cy"));
    const [adaUser, beaUser, cyUser] = await Promise.all([ada, bea, cy].map((agent) => createProfile(db, account.id, agent.id)));
    for (const user of [adaUser!, beaUser!, cyUser!]) await ensureBrowser(account.id, user);
    expect((await browsersOpen(account.id)).sort()).toEqual([adaUser, beaUser, cyUser].sort());

    // The person is looking at Bea's screen, and Cy has work running.
    const stopWatching = screenOpened(account.id, beaUser!);
    const [job] = await db
      .insert(delegations)
      .values({ accountId: account.id, conversationId: (await roomFor(account.id, cy.id)), parentAgentId: cy.id, childAgentId: cy.id, task: "Fill in the form.", status: "running" })
      .returning();

    // Nothing was used a whole hour ago, so the hourly rule closes nothing.
    expect(await closeIdleBrowsers(db, account.id, { idleMs: 60 * 60 * 1000 })).toEqual([]);
    // With no idle time required, only the browser nobody needs goes.
    expect(await closeIdleBrowsers(db, account.id, { idleMs: 0 })).toEqual([adaUser]);
    expect((await browsersOpen(account.id)).sort()).toEqual([beaUser, cyUser].sort());

    // Once the screen is closed and the work is done, those go too.
    stopWatching();
    await db.update(delegations).set({ status: "done" }).where(eqId(job!.id));
    expect((await closeIdleBrowsers(db, account.id, { idleMs: 0 })).sort()).toEqual([beaUser, cyUser].sort());
    expect(await browsersOpen(account.id)).toEqual([]);

    // The desktops behind them (a virtual screen and its viewer each) are stopped the same way.
    expect((await desktopsOpen(account.id)).sort()).toEqual([adaUser, beaUser, cyUser].sort());
    const watchAgain = screenOpened(account.id, beaUser!);
    expect((await closeIdleDesktops(db, account.id, { idleMs: 0 })).sort()).toEqual([adaUser, cyUser].sort());
    watchAgain();
    expect(await desktopsOpen(account.id)).toEqual([beaUser]);

    // A stopped desktop and its browser start again by themselves on the next browser call.
    expect(await runBrowserTool(account.id, adaUser!, "browser_navigate", { url: "https://example.com/" })).toContain("Example Domain");
    expect(await browsersOpen(account.id)).toEqual([adaUser]);
    expect((await desktopsOpen(account.id)).sort()).toEqual([adaUser, beaUser].sort());
  }, 600_000);
});

import { eq } from "drizzle-orm";
import { conversations, members } from "../db/schema.js";
const eqId = (id: string) => eq(delegations.id, id);
async function roomFor(accountId: string, agentId: string): Promise<string> {
  const [room] = await db.insert(conversations).values({ accountId, kind: "direct", ownerAgentId: agentId, title: "dm" }).returning();
  await db.insert(members).values({ conversationId: room!.id, accountId, agentId });
  return room!.id;
}
