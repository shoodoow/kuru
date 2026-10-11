import { afterEach, expect, test } from "vitest";
import { createCore } from "./api";
import { coreBaseUrl, defaultCoreUrl, normalizeCoreUrl, saveCoreUrl, savedCoreUrl } from "./core-url";

afterEach(() => saveCoreUrl(null));

test("an address the person typed is cleaned up, and nonsense is refused", () => {
  expect(normalizeCoreUrl(" agents.example.com/ ")).toBe("https://agents.example.com");
  expect(normalizeCoreUrl("https://agents.example.com/core/")).toBe("https://agents.example.com/core");
  // A local address is almost always plain http.
  expect(normalizeCoreUrl("192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
  expect(normalizeCoreUrl("localhost:3000")).toBe("http://localhost:3000");
  expect(normalizeCoreUrl("ftp://example.com")).toBeNull();
  expect(normalizeCoreUrl("not a url")).toBeNull();
  expect(normalizeCoreUrl("")).toBeNull();
});

test("the saved address wins over the build's own, and clearing it goes back", () => {
  expect(coreBaseUrl()).toBe(defaultCoreUrl());
  saveCoreUrl("https://mine.example.com");
  expect(coreBaseUrl()).toBe("https://mine.example.com");
  saveCoreUrl(null);
  expect(savedCoreUrl()).toBeNull();
  expect(coreBaseUrl()).toBe(defaultCoreUrl());
  // Saving the build's own address is the same as having none saved.
  saveCoreUrl(defaultCoreUrl());
  expect(savedCoreUrl()).toBeNull();
});

test("a client made without an address follows a change of server", async () => {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    return new Response("[]", { status: 200 });
  };
  const core = createCore(undefined, fetchImpl);
  await core.listAgents("a1");
  saveCoreUrl("https://mine.example.com");
  await core.listAgents("a1");
  expect(asked).toEqual([`${defaultCoreUrl()}/accounts/a1/agents`, "https://mine.example.com/accounts/a1/agents"]);
});
