import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { browserCommands, findFileFieldScript, siteNotePath, snapshotText } from "./browser-bridge.js";
import { accountContainerHostConfig, containerName, sharesGpu } from "../linux/linux.js";

describe("browser bridge", () => {
  it("rejects unknown tools, non-http navigation and anything that is not a ref from a snapshot", () => {
    expect(() => browserCommands("bash", {})).toThrow(/Unknown browser tool/);
    expect(() => browserCommands("browser_navigate", { url: "file:///etc/passwd" })).toThrow(/http/);
    expect(browserCommands("browser_navigate", { url: "https://example.com/path" })[0]).toEqual(["open", "https://example.com/path"]);
    expect(browserCommands("browser_click", { uid: "e12" })[0]).toEqual(["click", "@e12"]);
    expect(browserCommands("browser_click", { uid: "@e12" })[0]).toEqual(["click", "@e12"]);
    // A selector or a shell fragment is never passed through as a target.
    expect(() => browserCommands("browser_click", { uid: "body; rm -rf ~" })).toThrow(/not an element reference/);
    expect(() => browserCommands("browser_upload", { uid: "e3", path: "/etc/shadow" })).toThrow(/home or \/shared/);
    expect(() => browserCommands("browser_upload", { uid: "e3", path: "/shared/../etc/shadow" })).toThrow(/home or \/shared/);
    expect(browserCommands("browser_read", {})).toEqual([["read"]]);
    expect(browserCommands("browser_tabs", { action: "switch", tab: "t2" })[0]).toEqual(["tab", "t2"]);
  });

  it("presses and holds when asked, by ref or at a position", () => {
    expect(browserCommands("browser_click", { uid: "e4", holdMs: 12_000 }).slice(0, 4)).toEqual([
      ["hover", "@e4"],
      ["mouse", "down"],
      ["wait", "12000"],
      ["mouse", "up"],
    ]);
    expect(browserCommands("browser_click_at", { x: 10, y: 20, holdMs: 99_000 }).slice(0, 4)).toEqual([
      ["mouse", "move", "10", "20"],
      ["mouse", "down"],
      ["wait", "30000"],
      ["mouse", "up"],
    ]);
    expect(browserCommands("browser_click_at", { x: 10, y: 20 }).slice(0, 3)).toEqual([["mouse", "move", "10", "20"], ["mouse", "down"], ["mouse", "up"]]);
  });

  it("finds a hidden file field by the kind of file, and lists them when it cannot choose", () => {
    expect(browserCommands("browser_upload", { path: "/shared/a.png" })).toEqual([]);
    const page = new JSDOM(`<div>Gig images<input type="file" accept="image/*" hidden></div><div>Video<input type="file" accept="video/mp4"></div><div>Docs<input type="file" accept=".pdf"></div>`, { runScripts: "outside-only" });
    const run = (name: string, pick: number | null) => page.window.eval(findFileFieldScript(name, pick)) as string;
    expect(run("cover.png", null)).toMatch(/^marked 1\. accepts image\/\*, near "Gig images"/);
    expect(page.window.document.querySelectorAll("[data-kuru-upload]")).toHaveLength(1);
    expect(run("brief.pdf", null)).toMatch(/^marked 3\./);
    expect(run("notes.txt", null)).toMatch(/^several\n1\. accepts image/);
    expect(run("notes.txt", 2)).toMatch(/^marked 2\./);
    expect(new JSDOM("<p>none</p>", { runScripts: "outside-only" }).window.eval(findFileFieldScript("a.png", null))).toBe("none");
  });

  it("sends the whole page once, then only what changed, in the tree's own form", () => {
    expect(browserCommands("browser_snapshot", { full: true })[0]).toEqual(["snapshot", "-u", "--delta", "--full", "--json"]);
    expect(browserCommands("browser_snapshot", { scope: "form", interactive: true })[0]).toEqual(["snapshot", "-u", "--delta", "-i", "-s", "form", "--json"]);
    const answer = (snapshot: unknown) => JSON.stringify({ success: true, data: { snapshot }, error: null });
    expect(snapshotText(answer({ kind: "full", tree: '- button "Publish" [ref=e2]' }))).toBe('- button "Publish" [ref=e2]');
    expect(snapshotText(answer({ kind: "unchanged" }))).toMatch(/Nothing changed/);
    const delta = snapshotText(
      answer({
        kind: "delta",
        changes: [{ op: "add", ref: "@e4", node: { role: "option", name: "AI Agents" } }, { op: "remove", ref: "@e9", node: { role: "dialog", name: "Cookies" } }],
        treeChange: { startLine: 13, deleteCount: 0, lines: ['- listbox [ref=e3]', '  - option "AI Agents" [ref=e4]'] },
      }),
    )!;
    expect(delta).toContain('option "AI Agents" [ref=e4]');
    expect(delta).toContain('Gone:\n- dialog "Cookies" [ref=e9]');
    expect(snapshotText("not json")).toBeNull();
  });

  it("reads a page as markdown, by its outline or one section", () => {
    expect(browserCommands("browser_read", {})).toEqual([["read"]]);
    expect(browserCommands("browser_read", { outline: true, filter: "pricing" })).toEqual([["read", "--outline", "--filter", "pricing"]]);
    expect(browserCommands("browser_read", { uid: "e5" })).toEqual([["get", "text", "@e5"]]);
  });

  it("keeps one note per website, named by its host", () => {
    expect(siteNotePath("https://www.Instagram.com/accounts/login/?next=x")).toBe("/shared/notes/sites/instagram.com.md");
    expect(siteNotePath("not a url")).toBeNull();
  });

  it("keeps each account in its own container with no docker socket", () => {
    const account = "11111111-1111-4111-8111-111111111111";
    expect(containerName("alice@example.com")).toBe("nano-alice-at-example.com");
    const host = accountContainerHostConfig(account);
    expect(host.Binds).toEqual([`nano-account-${account}:/var/nano`]);
    expect(host.Privileged).toBe(false);
    expect(JSON.stringify(host.Binds)).not.toContain("docker.sock");
    expect(host.DeviceRequests).toBeUndefined();
  });

  it("gives a computer the graphics card only where Docker can hand one over", () => {
    expect(sharesGpu("auto", ["runc", "nvidia"])).toBe(true);
    expect(sharesGpu("auto", ["runc"])).toBe(false);
    // A virtual machine cannot take the card this way.
    expect(sharesGpu("auto", ["runc", "nvidia", "kata"], "kata")).toBe(false);
    expect(sharesGpu("off", ["runc", "nvidia"])).toBe(false);
    expect(sharesGpu("on", ["runc"])).toBe(true);
    const host = accountContainerHostConfig("11111111-1111-4111-8111-111111111111", { memoryBytes: 1024 ** 3, cpus: 2, gpu: true });
    expect(host.DeviceRequests).toEqual([{ Driver: "nvidia", Count: -1, Capabilities: [["gpu", "compute", "utility", "video"]] }]);
    expect(host.Privileged).toBe(false);
  });
});
