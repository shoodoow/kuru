import { describe, expect, it } from "vitest";
import { browserCommands, siteNotePath } from "./browser-bridge.js";
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
    expect(browserCommands("browser_read", {})).toEqual([["get", "text", "body"]]);
    expect(browserCommands("browser_tabs", { action: "switch", tab: "t2" })[0]).toEqual(["tab", "t2"]);
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
