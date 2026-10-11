import { describe, expect, it } from "vitest";
import { checkProvider, unknownModel } from "./check-provider.js";

type Seen = { url: string; headers: Record<string, string> };

/** A provider that answers every request the same way and records what it was asked. */
function provider(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return answer();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const models = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) });

describe("checking a provider before saving it", () => {
  it("accepts a key the provider answers to, and asks each provider its own way", async () => {
    const openai = provider(() => models("gpt-5", "gpt-5-mini"));
    expect(await checkProvider("openai", " sk-1 ", null, openai.fetchImpl)).toEqual({ ok: true, models: ["gpt-5", "gpt-5-mini"] });
    expect(openai.seen[0]).toEqual({ url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer sk-1" } });

    const anthropic = provider(() => models("claude-sonnet-5-5"));
    await checkProvider("anthropic", "sk-ant", null, anthropic.fetchImpl);
    expect(anthropic.seen[0]).toEqual({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" },
    });

    const xai = provider(() => models("grok-4"));
    await checkProvider("xai", "xai-1", null, xai.fetchImpl);
    expect(xai.seen[0]!.url).toBe("https://api.x.ai/v1/models");
  });

  it("uses the address given for a local or custom server, with or without a key", async () => {
    const local = provider(() => Response.json({ data: [{ id: "llama3" }] }));
    expect(await checkProvider("local", "", "http://192.168.1.20:11434/v1/", local.fetchImpl)).toEqual({ ok: true, models: ["llama3"] });
    expect(local.seen[0]).toEqual({ url: "http://192.168.1.20:11434/v1/models", headers: {} });

    const custom = provider(() => models("nvidia/nemotron"));
    await checkProvider("openai", "nv-key", "https://integrate.api.nvidia.com/v1", custom.fetchImpl);
    expect(custom.seen[0]!.url).toBe("https://integrate.api.nvidia.com/v1/models");
  });

  it("refuses a key the provider rejects", async () => {
    const refused = provider(() => new Response("{}", { status: 401 }));
    expect(await checkProvider("openai", "sk-bad", null, refused.fetchImpl)).toEqual({
      ok: false,
      error: "api.openai.com refused that key. Check you copied all of it and that it is still active.",
    });
    expect(await checkProvider("local", "", "https://llm.example.com/v1", refused.fetchImpl)).toMatchObject({ ok: false, error: "llm.example.com needs an API key." });
  });

  it("refuses an address where nothing answers, or where something else does", async () => {
    const dead = provider(() => {
      throw new TypeError("fetch failed");
    });
    const down = await checkProvider("local", "", "http://localhost:9999/v1", dead.fetchImpl);
    expect(down).toMatchObject({ ok: false });
    expect((down as { error: string }).error).toMatch(/Nothing answered at http:\/\/localhost:9999\/v1/);

    const website = provider(() => new Response("<html>hello</html>", { status: 200 }));
    expect(await checkProvider("local", "", "https://example.com", website.fetchImpl)).toMatchObject({
      ok: false,
      error: "Something answered at https://example.com, but it is not a model API. Most servers want the address to end in /v1.",
    });
    const empty = provider(() => Response.json({ data: [] }));
    expect(await checkProvider("local", "", "https://example.com/v1", empty.fetchImpl)).toMatchObject({ ok: false });
  });

  it("catches a wrong key on a gateway whose model list is open to anyone", async () => {
    const gateway = (good: boolean) =>
      (async (input: string | URL | Request) =>
        String(input).endsWith("/models")
          ? Response.json({ data: [{ id: "llama3" }] })
          : new Response("{}", { status: good ? 400 : 401 })) as typeof fetch;
    expect(await checkProvider("local", "sk-wrong", "https://gateway.example.com/v1", gateway(false))).toEqual({
      ok: false,
      error: "gateway.example.com refused that key. Check you copied all of it and that it is still active.",
    });
    expect(await checkProvider("local", "sk-right", "https://gateway.example.com/v1", gateway(true))).toEqual({ ok: true, models: ["llama3"] });
  });

  it("reads a refusal that arrives as a plain 400", async () => {
    const wordy = provider(() => Response.json({ error: "Incorrect API key provided." }, { status: 400 }));
    expect(await checkProvider("xai", "xai-bad", null, wordy.fetchImpl)).toMatchObject({ ok: false, error: expect.stringMatching(/refused that key/) });
  });

  it("points out an address that is missing /v1", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return String(input).endsWith("/v1/models") ? Response.json({ data: [{ id: "llama3" }] }) : new Response("no", { status: 404 });
    }) as typeof fetch;
    expect(await checkProvider("local", "", "http://192.168.1.20:11434", fetchImpl)).toEqual({
      ok: false,
      error: "That address is missing its last part. Use http://192.168.1.20:11434/v1.",
    });
    expect(seen).toEqual(["http://192.168.1.20:11434/models", "http://192.168.1.20:11434/v1/models"]);
  });

  it("lets a custom server with no model list through, with a note", async () => {
    const bare = provider(() => new Response("not found", { status: 404 }));
    const result = await checkProvider("local", "", "https://llm.example.com/v1", bare.fetchImpl);
    expect(result.ok).toBeNull();
    expect((result as { note: string }).note).toMatch(/could not be checked/);
    // The same answer from an official provider is a fault, not a pass.
    expect((await checkProvider("openai", "sk-1", null, bare.fetchImpl)).ok).toBe(false);
  });
});

describe("checking a model id against the provider's list", () => {
  it("passes a listed id, and an empty list where nothing is known", () => {
    expect(unknownModel("gpt-5", ["gpt-5", "gpt-5-mini"])).toBeNull();
    expect(unknownModel("anything", [])).toBeNull();
  });

  it("accepts the spellings providers take but do not list", () => {
    const listed = ["xiaomi/mimo-v2.6-flash", "claude-sonnet-5-5-20260101", "meta/llama-4:free"];
    expect(unknownModel("MiMo-V2.6-Flash", listed)).toBeNull();
    expect(unknownModel("xiaomi/MiMo-V2.6-Flash", listed)).toBeNull();
    expect(unknownModel("claude-sonnet-5-5", listed)).toBeNull();
    expect(unknownModel("llama-4", listed)).toBeNull();
    expect(unknownModel("mimo-v2", listed)).not.toBeNull();
  });

  it("names close matches for a mistyped id", () => {
    expect(unknownModel("claude-sonet-5-5", ["claude-sonnet-5-5", "claude-opus-5-5", "gpt-5"])).toBe(
      'This provider has no model called "claude-sonet-5-5". Did you mean: claude-opus-5-5, claude-sonnet-5-5, and others.',
    );
    expect(unknownModel("zzz", ["a-1", "b-2"])).toBe('This provider has no model called "zzz". It offers: a-1, b-2.');
  });
});
