import { expect, test } from "vitest";
import { proseCodeAsText } from "./send-message.js";

test("a sentence put in a code block is sent as text", () => {
  const line = "Full sweep running — all mail, noise out, money archived, only decisions left in inbox.";
  expect(proseCodeAsText({ kind: "code", code: line })).toEqual({ kind: "text", markdown: line });
});

test("real code stays a code block", () => {
  for (const code of ["pnpm install express", "git commit -m fix", "const a = 1;", "line one\nline two of the script here, really."]) {
    expect(proseCodeAsText({ kind: "code", code }).kind).toBe("code");
  }
  expect(proseCodeAsText({ kind: "code", language: "text", code: "This is a sentence, kept as the model asked." }).kind).toBe("code");
});
