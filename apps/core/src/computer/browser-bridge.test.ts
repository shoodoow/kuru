import { describe, expect, it } from "vitest";
import { browserBridgeRequest } from "./browser-bridge.js";
import { accountContainerHostConfig, containerName, sharesGpu } from "../linux/linux.js";

describe("browser bridge", () => {
  it("rejects unknown tools and non-http navigation", () => {
    expect(() => browserBridgeRequest("bash", {})).toThrow(/Unknown browser tool/);
    expect(() => browserBridgeRequest("browser_navigate", { url: "file:///etc/passwd" })).toThrow(/http/);
    const body = JSON.parse(browserBridgeRequest("browser_navigate", { url: "https://example.com/path" }));
    expect(body).toEqual({ tool: "browser_navigate", args: { url: "https://example.com/path" } });
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
