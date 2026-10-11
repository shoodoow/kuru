import { describe, expect, it } from "vitest";
import { byteRange } from "./conversations.js";

/** Locks how a video player's Range header maps onto a file, since a wrong range plays garbage. */
describe("byteRange", () => {
  it("sends everything when there is no usable header", () => {
    expect(byteRange(undefined, 100)).toBeUndefined();
    expect(byteRange("items=0-5", 100)).toBeUndefined();
  });

  it("reads closed, open-ended and suffix ranges", () => {
    expect(byteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    // An end past the file is cut back to its last byte.
    expect(byteRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });

  it("rejects a range outside the file", () => {
    expect(byteRange("bytes=100-", 100)).toBe("invalid");
    expect(byteRange("bytes=20-10", 100)).toBe("invalid");
  });
});
