import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { collapseOldSteps, compactTranscript, compactionThreshold, dropStaleViews, isLookOnlyStep, isReadOnlyShell, isSingleSmallCallStep, resumableTranscript, transcriptForStorage, StuckWatch, callTargets, stepFailed, splitForSummary, withStateSummary, cutKind } from "./worker-loop.js";

const call = (id: string, toolName: string, input: unknown): ModelMessage =>
  ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input }] }) as ModelMessage;
const answer = (id: string, toolName: string, value: string): ModelMessage =>
  ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }] }) as ModelMessage;

describe("isReadOnlyShell", () => {
  it("treats looking as looking", () => {
    for (const command of [
      "cat a.txt && ls -la",
      "sed -n '100,200p' cli.js",
      "grep -n width dist/cli.js | head -20",
      "D=/x/dist; node -e \"const s=require('fs').readFileSync('$D/a.js','utf8'); console.log(s.slice(0,200))\"",
      "npx --yes hyperframes@0.6.51 docs gsap 2>&1 | head -140 | cat",
      "find . -name SKILL.md 2>/dev/null",
      "cd ~/work/x && cat index.html",
    ]) {
      expect([command, isReadOnlyShell(command)]).toEqual([command, true]);
    }
  });

  it("treats changing or running things as doing", () => {
    for (const command of [
      "npx hyperframes render -o out.mp4",
      "echo hi > file.txt",
      "sed -i 's/a/b/' file",
      "python3 build.py",
      "mkdir -p work && cd work",
      "find . -name '*.tmp' -delete",
      "npm install",
    ]) {
      expect([command, isReadOnlyShell(command)]).toEqual([command, false]);
    }
  });
});

describe("isLookOnlyStep", () => {
  it("is true only when every call in the step just looks", () => {
    expect(isLookOnlyStep([{ name: "read", input: { path: "/a" } }, { name: "bash", input: { command: "ls" } }])).toBe(true);
    expect(isLookOnlyStep([{ name: "read", input: { path: "/a" } }, { name: "write", input: { path: "/b", body: "x" } }])).toBe(false);
    expect(isLookOnlyStep([{ name: "bash", input: { command: "npm run build" } }])).toBe(false);
    expect(isLookOnlyStep([])).toBe(false);
  });
});

describe("compactTranscript", () => {
  const big = "x".repeat(5_000);
  const transcript: ModelMessage[] = [
    { role: "user", content: `the brief ${big}` },
    call("1", "bash", { command: "cat big" }),
    answer("1", "bash", big),
    call("2", "write", { path: "/a.html", body: big }),
    answer("2", "write", "Wrote the file."),
    call("3", "bash", { command: "ls" }),
    answer("3", "bash", big),
  ];

  it("trims old output and old file bodies, keeps the brief and recent steps whole", () => {
    const out = compactTranscript(transcript, { keepRecent: 2, toolChars: 200, inputChars: 100 });
    expect(out).toHaveLength(transcript.length);
    expect(out[0]).toBe(transcript[0]);
    expect(JSON.stringify(out[2]).length).toBeLessThan(700);
    expect(JSON.stringify(out[2])).toContain("trimmed");
    expect(JSON.stringify(out[3]).length).toBeLessThan(500);
    expect(out[5]).toBe(transcript[5]);
    expect(out[6]).toBe(transcript[6]);
    // Calls and results stay paired.
    expect(out.map((message) => message.role)).toEqual(transcript.map((message) => message.role));
  });

  it("drops pictures when storing and fits the size limit", () => {
    const withImage: ModelMessage[] = [
      { role: "user", content: "brief" },
      call("1", "computer_screenshot", {}),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "computer_screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot saved at /shared/a.png" },
                { type: "file", mediaType: "image/png", data: { type: "data", data: "A".repeat(50_000) } },
              ],
            },
          },
        ],
      } as never,
    ];
    const stored = transcriptForStorage(withImage);
    const text = JSON.stringify(stored);
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("Screenshot saved at /shared/a.png");
    expect(text).toContain("no longer in view");
    const tight = transcriptForStorage(transcript, 3_000);
    expect(JSON.stringify(tight).length).toBeLessThan(8_000);
  });
});

describe("collapseOldSteps", () => {
  const steps = (from: number, count: number): ModelMessage[] =>
    Array.from({ length: count }, (_, index) => [
      call(String(from + index), "bash", { command: `npm run step-${from + index}` }),
      answer(String(from + index), "bash", "y".repeat(2_000)),
    ]).flat();

  it("replaces old steps with one note, keeping the brief, every instruction and the newest steps", () => {
    const transcript: ModelMessage[] = [
      { role: "user", content: "the brief" },
      ...steps(1, 10),
      { role: "user", content: "Note from the agent: use pauses in the voice-over." },
      ...steps(11, 10),
    ];
    const out = collapseOldSteps(transcript, 6);
    expect(out[0]).toBe(transcript[0]);
    expect(out).toHaveLength(2 + 6);
    const note = String(out[1]!.content);
    expect(note).toContain("use pauses in the voice-over");
    expect(note).toContain("- bash: npm run step-1");
    // Only the start of each old result stays, enough to know what it said.
    expect(note).not.toContain("y".repeat(200));
    expect(note).toContain(`→ ${"y".repeat(160)}…`);
    expect(out.slice(2)).toEqual(transcript.slice(-6));
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(transcript).length / 3);
  });

  it("never leaves a tool result without its call", () => {
    const transcript: ModelMessage[] = [{ role: "user", content: "brief" }, ...steps(1, 10)];
    // Seven kept messages would start on a tool result; the cut moves past it.
    const out = collapseOldSteps(transcript, 7);
    expect(out[2]!.role).toBe("assistant");
  });

  it("carries an earlier collapse forward instead of nesting it, and stays bounded", () => {
    let transcript: ModelMessage[] = [{ role: "user", content: "brief" }, { role: "user", content: "Keep the logo small." }];
    for (let round = 0; round < 30; round += 1) {
      transcript = collapseOldSteps([...transcript, ...steps(round * 10, 10)], 6);
    }
    const note = String(transcript[1]!.content);
    expect(note.match(/Earlier steps of this job/g)).toHaveLength(1);
    expect(note).toContain("Keep the logo small.");
    expect(note).toMatch(/\(\d+ earlier tool calls not listed\)/);
    expect(JSON.stringify(transcript).length).toBeLessThan(25_000);
  });

  it("leaves a short conversation alone", () => {
    const transcript: ModelMessage[] = [{ role: "user", content: "brief" }, ...steps(1, 2)];
    expect(collapseOldSteps(transcript, 16)).toBe(transcript);
  });
});

describe("resumableTranscript", () => {
  it("drops a tool call that never got its result", () => {
    const cut: unknown[] = [
      { role: "user", content: "brief" },
      call("1", "bash", { command: "ls" }),
      answer("1", "bash", "a b c"),
      call("2", "bash", { command: "npm run build" }),
    ];
    const out = resumableTranscript(cut);
    expect(out).toHaveLength(3);
    expect(out.at(-1)?.role).toBe("tool");
  });

  it("keeps a complete conversation and ignores junk", () => {
    const whole: unknown[] = [{ role: "user", content: "brief" }, call("1", "bash", {}), answer("1", "bash", "ok"), null, "x"];
    expect(resumableTranscript(whole)).toHaveLength(3);
    expect(resumableTranscript("nope" as never)).toEqual([]);
  });
});

describe("compactionThreshold", () => {
  it("is 80% of the window, at most 150K, at least 24K", () => {
    expect(compactionThreshold(1_000_000)).toBe(150_000);
    expect(compactionThreshold(128_000)).toBe(102_400);
    expect(compactionThreshold(32_000)).toBe(25_600);
    expect(compactionThreshold(16_000)).toBe(24_000);
    expect(compactionThreshold(null)).toBe(102_400);
  });
});

describe("state summary", () => {
  const call = (id: string, command: string): ModelMessage =>
    ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command } }] }) as ModelMessage;
  const result = (id: string, text: string): ModelMessage =>
    ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: text } }] }) as ModelMessage;
  const job: ModelMessage[] = [
    { role: "user", content: "Send today's three outreach emails." },
    call("1", "cat send-log.md"),
    result("1", "x".repeat(40_000)),
    { role: "user", content: "Note from the agent you work for (read it, then carry on from where you are):\nKeep it to 5 a day." },
    { role: "user", content: "Your last 8 steps only read and searched." },
    call("2", "cat shortlist.md"),
    result("2", "y".repeat(40_000)),
    call("3", "ls"),
    result("3", "a.md b.md"),
  ];

  it("keeps the brief and the newest steps whole, and never starts the kept part on a tool result", () => {
    const parts = splitForSummary(job, 12_000)!;
    expect(parts.brief).toBe(job[0]);
    expect(parts.recent[0]!.role).not.toBe("tool");
    expect(parts.recent.at(-1)).toBe(job.at(-1));
    expect([parts.brief, ...parts.older, ...parts.recent]).toEqual(job);
  });

  it("carries the agent's words verbatim, not the loop's nudges, across repeated summaries", () => {
    const first = withStateSummary(splitForSummary(job, 5_000)!, "## Goal\n- send three emails");
    const note = (first[1] as { content: string }).content;
    expect(note).toContain("Keep it to 5 a day.");
    expect(note).not.toContain("only read and searched");
    expect(note).toContain("## State of the job\n## Goal");
    const again = withStateSummary(splitForSummary([...first, call("4", "pwd"), result("4", "z".repeat(60_000)), call("5", "ls"), result("5", "ok")], 1_000)!, "## Goal\n- later");
    const second = (again[1] as { content: string }).content;
    expect(second.match(/Keep it to 5 a day\./g)).toHaveLength(1);
    expect(again[0]).toBe(job[0]);
  });

  it("returns null when there is nothing old enough to summarize", () => {
    expect(splitForSummary(job.slice(0, 1))).toBeNull();
  });
});

describe("stale views of a page", () => {
  const view = (name: string, text: string, id: string): ModelMessage =>
    ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value: text } }] }) as ModelMessage;
  const page = (title: string): string => `✓ ${title}\n  https://shop.example/${title}\n${"- link \"Item\" [ref=e1]\n".repeat(300)}`;

  it("keeps the newest full page with the changes after it, and drops older pages", () => {
    const change = (lines: string) => `Changed since your last snapshot; the rest of the page is as you saw it.\nNew or changed:\n${lines}`;
    const talk: ModelMessage[] = [
      { role: "user", content: "Buy the blue one." },
      view("browser_navigate", page("home"), "1"),
      view("bash", "x".repeat(5000), "2"),
      view("browser_snapshot", page("list"), "3"),
      view("browser_click", "✗ Unknown ref: e9", "4"),
      view("browser_snapshot", page("item"), "5"),
      view("browser_snapshot", change("- button \"Add\" [ref=e7]\n".repeat(40)), "6"),
      view("browser_snapshot", change("- dialog \"Cart\" [ref=e8]\n".repeat(40)), "7"),
      view("browser_snapshot", "Nothing changed on the page since your last snapshot; its refs still hold.", "8"),
    ];
    const out = dropStaleViews(talk);
    const text = (index: number): string => ((out[index] as { content: { output: { value: string } }[] }).content[0]!.output.value);
    // The newest full tree and every change after it are the page as it is now.
    expect(text(5)).toBe(page("item"));
    expect(text(6)).toContain("Add");
    expect(text(7)).toContain("Cart");
    // Older pages keep only where they were.
    expect(text(3)).toContain("https://shop.example/list");
    expect(text(3)).toContain("An earlier view of the page was here");
    expect(text(1).length).toBeLessThan(500);
    // Command output and short answers are not views of the page.
    expect(text(2)).toHaveLength(5000);
    expect(text(4)).toBe("✗ Unknown ref: e9");
    expect(out).toHaveLength(talk.length);
  });

  it("keeps only the newest picture", () => {
    const shot = (id: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "browser_screenshot", output: { type: "content", value: [{ type: "text", text: "Screenshot." }, { type: "media", data: "AAAA", mediaType: "image/png" }] } }] }) as ModelMessage;
    const out = dropStaleViews([{ role: "user", content: "Look." }, shot("1"), view("browser_snapshot", page("a"), "2"), shot("3")]);
    expect(JSON.stringify(out[3])).toContain("AAAA");
    expect(JSON.stringify(out[1])).not.toContain("AAAA");
    expect(JSON.stringify(out[2])).toContain("https://shop.example/a");
  });

});

describe("StuckWatch", () => {
  const covered = { output: { type: "text", value: "✗ Element '@e12750' is covered by <div.orca-combo-box.category-selector__value-container>" } };
  const ok = { output: { type: "text", value: "true" } };
  const evalClick = (comment: string) => ({
    name: "browser_eval",
    input: { script: `// ${comment}\ndocument.querySelectorAll('#gig-edit-create-form .category-selector__value-container')[1]?.click();\ntrue` },
  });

  it("catches the same dropdown tried with differently worded scripts and refused clicks", () => {
    const watch = new StuckWatch();
    const steps = [
      [evalClick("open it"), ok],
      [{ name: "browser_click", input: { uid: "e12750" } }, covered],
      [evalClick("try the subcategory"), ok],
      [evalClick("click the container"), ok],
      [{ name: "browser_click", input: { uid: "e12750" } }, covered],
      [evalClick("open it with the first container"), ok],
    ] as const;
    for (const [call, result] of steps) expect(watch.record([call], [result])).toBeNull();
    expect(watch.record([evalClick("once more")], [ok])).toMatch(/5 tries on #gig-edit-create-form \.category-selector__value-container/);
  });

  it("catches a run of failures, and lets ordinary progress through", () => {
    const watch = new StuckWatch();
    const fail = { output: { type: "text", value: "✗ Could not locate element" } };
    for (let index = 0; index < 3; index += 1) expect(watch.record([{ name: "browser_click", input: { uid: `e${index}` } }], [fail])).toBeNull();
    expect(watch.record([{ name: "browser_click", input: { uid: "e9" } }], [fail])).toMatch(/last 4 steps all failed/);
    const fresh = new StuckWatch();
    for (let index = 0; index < 12; index += 1) expect(fresh.record([{ name: "browser_fill", input: { uid: `e${index}`, value: "x" } }], [ok])).toBeNull();
  });

  it("reads targets from refs, fields and selectors, and failures from tool text", () => {
    expect(callTargets([{ name: "browser_click", input: { uid: "@E5" } }, { name: "browser_set_value", input: { field: "Delivery" } }])).toEqual(["uid:e5", "field:delivery"]);
    expect(stepFailed([covered])).toBe(true);
    expect(stepFailed([ok])).toBe(false);
    expect(stepFailed([])).toBe(false);
  });
});

describe("cutKind", () => {
  it("tells a step that only thought from one cut off mid-answer", () => {
    expect(cutKind({ finishReason: "length", text: "", toolCalls: [] })).toBe("thinking");
    expect(cutKind({ finishReason: "length", text: "  \n" })).toBe("thinking");
    expect(cutKind({ finishReason: "length", text: "Writing the file now", toolCalls: [] })).toBe("output");
    expect(cutKind({ finishReason: "length", text: "", toolCalls: [{}] })).toBe("output");
    expect(cutKind({ finishReason: "tool-calls", text: "", toolCalls: [{}] })).toBeNull();
    expect(cutKind({ finishReason: "stop", text: "done" })).toBeNull();
  });
});

describe("output limit and credit", () => {
  it("asks for a sensible answer length, never the model's whole maximum", async () => {
    const { workerOutputCap, WORKER_OUTPUT_TOKENS } = await import("./worker-loop.js");
    expect(workerOutputCap(235_929)).toBe(WORKER_OUTPUT_TOKENS);
    expect(workerOutputCap(8_192)).toBe(8_192);
    expect(workerOutputCap(null)).toBe(WORKER_OUTPUT_TOKENS);
  });

  it("reads what the provider can still pay for", async () => {
    const { affordableTokens } = await import("./worker-loop.js");
    expect(affordableTokens(new Error("This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 21083."))).toBe(21083);
    expect(affordableTokens(new Error("Invalid JSON response"))).toBeNull();
  });

  it("knows a credit refusal in any wording and marks the account for a while", async () => {
    const { isOutOfCreditError, noteCreditOutage, creditOutage, clearCreditOutage, OutOfCreditError } = await import("../model/credit.js");
    expect(isOutOfCreditError(Object.assign(new Error("Payment Required"), { statusCode: 402 }))).toBe(true);
    expect(isOutOfCreditError(new Error("Insufficient credits"))).toBe(true);
    expect(isOutOfCreditError(new Error("No endpoints found that support image input"))).toBe(false);
    expect(new OutOfCreditError().message).toMatch(/Do not restart/);
    noteCreditOutage("acct-credit", "openrouter", 1_000);
    expect(creditOutage("acct-credit", 2_000)).not.toBeNull();
    clearCreditOutage("acct-credit");
    expect(creditOutage("acct-credit", 2_000)).toBeNull();
  });
});

describe("withCacheMark", () => {
  it("marks only the newest message for Anthropic's cache", async () => {
    const { withCacheMark } = await import("./worker-loop.js");
    const marked = withCacheMark([
      { role: "user", content: "brief" },
      { role: "user", content: "old", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "user", content: "new" },
    ] as ModelMessage[]) as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }[];
    expect(marked[0]!.providerOptions).toBeUndefined();
    expect(marked[1]!.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    expect(marked[2]!.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });
});

describe("isSingleSmallCallStep", () => {
  it("is a step with one page action, page read, fetch or search", () => {
    expect(isSingleSmallCallStep([{ name: "browser_click" }])).toBe(true);
    expect(isSingleSmallCallStep([{ name: "web_fetch" }])).toBe(true);
  });

  it("is not a batch, a shell command, or several calls", () => {
    expect(isSingleSmallCallStep([{ name: "browser_batch" }])).toBe(false);
    expect(isSingleSmallCallStep([{ name: "bash" }])).toBe(false);
    expect(isSingleSmallCallStep([{ name: "browser_click" }, { name: "web_search" }])).toBe(false);
  });
});
