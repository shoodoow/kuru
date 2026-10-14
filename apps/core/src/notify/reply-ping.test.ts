import { describe, expect, it } from "vitest";
import { replyPreview } from "./reply-ping.js";

describe("replyPreview", () => {
  it("shows a reply as one plain line, without markdown or code", () => {
    expect(replyPreview("**Done.** Gig 3 is [live](https://fiverr.com/x).\n\n```js\nconsole.log(1)\n```")).toBe("Done. Gig 3 is live.");
    expect(replyPreview("word ".repeat(80)).length).toBeLessThanOrEqual(161);
    expect(replyPreview("```\nonly code\n```")).toBe("");
  });
});
