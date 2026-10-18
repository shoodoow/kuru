import { describe, expect, it } from "vitest";
import { executeSendMessage } from "./executors.js";

// Only the refusals are exercised here: each returns before anything is saved.
const ctx = (sent = 0) => ({ accountId: "acct", linuxProfile: "u1", emittedMessages: Array.from({ length: sent }, () => ({})) }) as never;

describe("send_message guards", () => {
  it("says which block was wrong and shows the file shape", async () => {
    const out = (await executeSendMessage(ctx(), { blocks: [{ kind: "widget", widget: "nope", props: {} }] })) as { error: string };
    expect(out.error).toContain("Nothing was sent.");
    expect(out.error).toContain('"kind": "file", "url"');
  });

  it("refuses a file name that is not a location, and one outside the sendable folders", async () => {
    const bare = (await executeSendMessage(ctx(), { blocks: [{ kind: "file", url: "video.mp4", name: "video.mp4" }] })) as { error: string };
    expect(bare.error).toContain("not a file location");
    const outside = (await executeSendMessage(ctx(), { blocks: [{ kind: "file", url: "/tmp/video.mp4", name: "video.mp4" }] })) as { error: string };
    expect(outside.error).toContain("/home/u1");
  });

  it("stops a turn that keeps sending", async () => {
    const out = (await executeSendMessage(ctx(5), { blocks: [{ kind: "text", markdown: "Resending clean." }] })) as { error: string };
    expect(out.error).toContain("already sent 5 messages");
  });
});
