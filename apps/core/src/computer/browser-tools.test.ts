import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { createProfile, exec, removeAccountContainers } from "../linux/linux.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { runBrowserTool, siteNotePath } from "./browser-bridge.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const db = getDb(databaseUrl);

const PAGE = `<html><head><title>Fixture shop</title></head><body><h1>Order form</h1>
<p>Welcome to the test shop. Prices include tax.</p>
<form><label>Name <input id="n" name="name" value="old"></label>
<select name="size" aria-label="Size"><option>Small</option><option>Large</option></select>
<button type="button" onclick="document.getElementById('o').textContent='Saved '+document.getElementById('n').value+' '+document.querySelector('select').value">Save</button></form>
<div id="o"></div><a href="/second.html">Second page</a>
<input aria-label="Search" onkeyup="if(event.key!=='Enter')document.getElementById('k').textContent='keys '+this.value.length" onkeydown="if(event.key==='Enter')document.getElementById('k').textContent='searched '+this.value">
<span id="k"></span><label><input type="checkbox" aria-label="Agree" onchange="document.getElementById('c').textContent=this.checked?'agreed':'not agreed'"></label><span id="c"></span>
<button aria-label="Menu" onmouseenter="document.getElementById('m').textContent='menu is open'">Menu</button><span id="m"></span>
<a href="/second.html" download="second.html">Get the file</a>
<label>Delivery time <input type="time" min="11:00" max="21:00" step="900" name="delivery"></label>
<label>Day <input type="date" name="day"></label><label>Amount <input type="range" min="0" max="100" name="amount"></label>
<canvas id="cv" width="200" height="100" style="position:fixed;right:0;bottom:0;background:#ccc" onclick="document.title='canvas '+(event.offsetX>0)"></canvas><div style="height:3000px"></div><p>Footer line at the very bottom.</p></body></html>`;

/** The ref agent-browser gave the element whose line contains this text. */
function refOf(tree: string, text: string): string {
  const line = tree.split("\n").find((row) => row.includes(text)) ?? "";
  const found = /\bref=(e\d+)/.exec(line)?.[1];
  if (!found) throw new Error(`No ref for "${text}" in:\n${tree}`);
  return found;
}

describe("browser tools", () => {
  afterAll(async () => {
    await removeAccountContainers({ testOnly: true });
    await db.$client.end();
  });

  it("reads a page, fills a form, clicks, goes back, and remembers a note about the site", async () => {
    const account = await createAccount(db, { name: "Browser" });
    const ada = await createAgent(db, account.id, { name: "Ada", label: "Ada", role: "Teammate", jobDescription: "Browses.", provider: "openai", modelId: "gpt-5" });
    const profile = await createProfile(db, account.id, ada.id);
      const run = (name: string, args: Record<string, unknown> = {}) => runBrowserTool(account.id, profile, name, args);
    await exec(account.id, ["sh", "-c", 'mkdir -p /tmp/site && cat > /tmp/site/index.html && echo "<title>Second</title><h1>Second page</h1>" > /tmp/site/second.html', "sh"], profile);
    await exec(account.id, ["sh", "-c", `printf %s "$1" > /tmp/site/index.html; cd /tmp/site && (setsid nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/site.log 2>&1 &) ; sleep 1`, "sh", PAGE], profile);
    const url = "http://127.0.0.1:8765/index.html";

    // Opening a page gives the page itself: its text and a ref on each control.
    const opened = await run("browser_navigate", { url });
    expect(opened).toContain('heading "Order form"');
    expect(opened).toContain("Prices include tax");
    expect(opened).toContain("No notes on this site yet");

    // Fill replaces what was in the field; select picks by label; the click is a real one.
    expect(await run("browser_fill", { uid: refOf(opened, 'textbox "Name"'), value: "Ada" })).not.toMatch(/✗/);
    expect(await run("browser_select", { uid: refOf(opened, 'combobox "Size"'), value: "Large" })).not.toMatch(/✗/);
    const clicked = await run("browser_click", { uid: refOf(opened, 'button "Save"') });
    expect(clicked).toContain("Fixture shop");
    expect(await run("browser_read")).toContain("Saved Ada Large");

    // Typing key by key reaches pages that listen to each key, and Enter submits.
    expect(await run("browser_type", { uid: refOf(opened, 'textbox "Search"'), text: "kuru", enter: true })).not.toMatch(/✗/);
    expect(await run("browser_check", { uid: refOf(opened, 'checkbox "Agree"') })).not.toMatch(/✗/);
    expect(await run("browser_hover", { uid: refOf(opened, 'button "Menu"') })).not.toMatch(/✗/);
    const after = await run("browser_read");
    expect(after).toContain("searched kuru");
    expect(after).toContain("agreed");
    expect(after).toContain("menu is open");
    expect(await run("browser_eval", { script: "document.querySelectorAll('a').length" })).toContain("2");

    // A time or date field shows in the tree only as its parts, so the page view names it and says how to set it.
    expect(opened).toContain("set with browser_set_value");
    expect(opened).toMatch(/- delivery \(time, min 11:00, max 21:00, step 900/);
    expect(await run("browser_set_value", { field: "delivery", value: "13:45" })).toBe('Set delivery to "13:45".');
    expect(await run("browser_set_value", { field: "Day", value: "2026-10-20" })).toBe('Set day to "2026-10-20".');
    expect(await run("browser_set_value", { field: "amount", value: "70" })).toBe('Set amount to "70".');
    // A value in the wrong form is refused with the form the field wants, instead of a false "done".
    expect(await run("browser_set_value", { field: "delivery", value: "1:45 PM" })).toMatch(/did not take "1:45 PM".*HH:MM in 24-hour time/);
    expect(await run("browser_set_value", { field: "nothing-here", value: "x" })).toMatch(/No field called "nothing-here"\. Fields on this page: .*delivery \(time\)/);
    // Nothing leaked into the other fields.
    expect(await run("browser_eval", { script: "document.querySelector('[name=name]').value + '|' + document.querySelector('[name=delivery]').value" })).toContain("Ada|");

    // A download is kept under the name asked for.
    const saved = await run("browser_download", { uid: refOf(opened, 'link "Get the file"'), name: "page.html", folder: `/home/${profile}/Downloads` });
    expect(saved).not.toMatch(/✗/);
    expect((await exec(account.id, ["cat", `/home/${profile}/Downloads/page.html`], profile)).stdout).toContain("Second page");

    // A click at a position reaches what has no ref, such as a canvas.
    const box = JSON.parse((await run("browser_eval", { script: "JSON.stringify(document.getElementById('cv').getBoundingClientRect())" })).replace(/^"|"$/g, "").replace(/\\"/g, '"')) as { x: number; y: number };
    expect(await run("browser_click_at", { x: box.x + 50, y: box.y + 50 })).toContain("canvas true");

    // A ref that is not on the page says so and says what to do.
    expect(await run("browser_click", { uid: "e9999" })).toMatch(/fresh browser_snapshot/);

    // Scrolling, a link, and back again, all in the same tab.
    expect(await run("browser_scroll", { direction: "down", pixels: 2500 })).not.toMatch(/✗/);
    const short = await run("browser_snapshot", { interactive: true });
    expect(short).not.toContain("Prices include tax");
    expect(await run("browser_click", { uid: refOf(short, 'link "Second page"') })).toContain("second.html");
    expect(await run("browser_back")).toContain("index.html");
    // A second tab, and back to the first.
    expect(await run("browser_tabs", { action: "new", url: "http://127.0.0.1:8765/second.html" })).toContain("second.html");
    const two = await run("browser_tabs", { action: "list" });
    expect(two.split("\n").filter((row) => row.includes("127.0.0.1:8765"))).toHaveLength(2);
    const newest = /\[(t\d+)\][^\n]*second\.html/.exec(two)?.[1];
    expect(await run("browser_tabs", { action: "close", tab: newest })).not.toMatch(/✗/);
    const tabs = await run("browser_tabs", { action: "list" });
    expect(tabs.split("\n").filter((row) => row.includes("127.0.0.1:8765"))).toHaveLength(1);

    // What the agent writes down about a site is shown the next time it opens it.
    const note = siteNotePath(url)!;
    await exec(account.id, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && echo "The Save button needs a name first." > "$1"', "sh", note], profile);
    expect(await run("browser_navigate", { url })).toContain("The Save button needs a name first.");

    const picture = await run("browser_screenshot", { path: "/shared/screenshots/test-page.png" });
    expect(picture).toMatch(/saved/i);
  }, 600_000);
});
