import { expect, test } from "vitest";
import { configureAuthCookie, createCore } from "./api";

test("requests carry the chosen account's session and never the phone's own cookie store", async () => {
  const seen: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(init ?? {});
    return new Response("[]", { status: 200 });
  };
  let session = "better-auth.session_token=account-a";
  configureAuthCookie(() => session);
  const core = createCore("https://agents.example.com", fetchImpl);
  await core.listAgents("a1");
  session = "better-auth.session_token=account-b";
  await core.listAgents("b1");
  expect(seen.map((init) => (init.headers as Record<string, string>).cookie)).toEqual([
    "better-auth.session_token=account-a",
    "better-auth.session_token=account-b",
  ]);
  expect(seen.every((init) => init.credentials === "omit")).toBe(true);
  configureAuthCookie(() => "");
});
