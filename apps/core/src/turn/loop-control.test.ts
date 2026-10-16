import { describe, expect, it } from "vitest";
import { promisesUnstartedWork,
  replyOnlyRestriction, shouldEndTurn } from "./loop-control.js";

const base = { handedOff: false, sentMessage: false, hiddenTurn: false };

describe("shouldEndTurn", () => {
  it("keeps going after an opening ack so the work can start", () => {
    expect(shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["send_message"]] })).toBe(false);
  });

  it("ends once a worker is running and the person has a bubble", () => {
    expect(
      shouldEndTurn({ ...base, handedOff: true, sentMessage: true, stepToolNames: [["send_message", "spawn_worker"]] }),
    ).toBe(true);
  });

  it("does not end a person-opened turn silent after a handoff", () => {
    expect(shouldEndTurn({ ...base, handedOff: true, stepToolNames: [["spawn_worker"]] })).toBe(false);
  });

  it("lets a hidden wake hand off without a bubble", () => {
    expect(shouldEndTurn({ ...base, handedOff: true, hiddenTurn: true, stepToolNames: [["spawn_worker"]] })).toBe(true);
  });

  it("ends when the answer is sent after earlier lookups", () => {
    expect(
      shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["send_message"], ["web_search"], ["send_message"]] }),
    ).toBe(true);
  });

  it("keeps going when a bubble and a lookup share one step", () => {
    expect(
      shouldEndTurn({ ...base, sentMessage: true, stepToolNames: [["read"], ["send_message", "web_fetch"]] }),
    ).toBe(false);
  });
});

describe("replyOnlyRestriction", () => {
  it("lets a stuck turn only hand the job on or say it is not done", () => {
    const stuck = replyOnlyRestriction({ finishedSteps: 2, maxSteps: 8, handedOff: false, sentMessage: true, hiddenTurn: false, stuck: true });
    expect(stuck?.activeTools).toEqual(["send_message", "spawn_worker", "delegate"]);
    expect(stuck?.note).toContain("NOT done");
    // Once the job was handed to a worker there is nothing left to correct.
    expect(replyOnlyRestriction({ finishedSteps: 2, maxSteps: 8, handedOff: true, sentMessage: true, hiddenTurn: false, stuck: true })).toBeNull();
  });

  it("leaves normal steps open", () => {
    expect(replyOnlyRestriction({ ...base, finishedSteps: 1, maxSteps: 6 })).toBeNull();
  });

  it("closes the last step to replying or handing off", () => {
    expect(replyOnlyRestriction({ ...base, finishedSteps: 5, maxSteps: 6 })?.activeTools).toEqual([
      "send_message",
      "spawn_worker",
      "delegate",
    ]);
  });

  it("does not count team setup steps against the budget", () => {
    const setup = [["enable_tools"], ["create_group"], ["hire_subagent"], ["hire_subagent"]];
    expect(replyOnlyRestriction({ ...base, finishedSteps: 4, maxSteps: 5, stepToolNames: setup })).toBeNull();
    const research = [["web_search"], ["read"], ["glob"], ["read"]];
    expect(replyOnlyRestriction({ ...base, finishedSteps: 4, maxSteps: 5, stepToolNames: research })).not.toBeNull();
  });

  it("asks for an ack right after a silent handoff", () => {
    expect(replyOnlyRestriction({ ...base, handedOff: true, finishedSteps: 1, maxSteps: 6 })?.activeTools).toEqual([
      "send_message",
    ]);
  });

  it("leaves steps open after a bubble, but still closes the last one", () => {
    expect(replyOnlyRestriction({ ...base, sentMessage: true, finishedSteps: 2, maxSteps: 6 })).toBeNull();
    expect(replyOnlyRestriction({ ...base, sentMessage: true, finishedSteps: 5, maxSteps: 6 })?.activeTools).toContain(
      "spawn_worker",
    );
  });
});

describe("promisesUnstartedWork", () => {
  const open = { handedOff: false, hiddenTurn: false };

  it("spots a promise with nothing started", () => {
    expect(promisesUnstartedWork({ ...open, text: "Understood. Let me stop the audio and get the render going." })).toBe(true);
    expect(promisesUnstartedWork({ ...open, text: "I'll build it now." })).toBe(true);
  });

  it("ignores answers, questions, and turns that already handed off", () => {
    expect(promisesUnstartedWork({ ...open, text: "It is 4pm in Riyadh." })).toBe(false);
    expect(promisesUnstartedWork({ ...open, text: "I'll build it. Want music too?" })).toBe(false);
    expect(promisesUnstartedWork({ handedOff: true, hiddenTurn: false, text: "I'll have it soon." })).toBe(false);
    expect(promisesUnstartedWork({ handedOff: false, hiddenTurn: true, text: "Let me fix that." })).toBe(false);
  });
});

describe("finalTextIsReply", () => {
  it("posts text when no bubble was sent", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["web_search"], []])).toBe(true);
  });

  it("posts the answer that follows an ack and a lookup", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["send_message"], ["read"], []])).toBe(true);
  });

  it("drops a sign-off that follows the last bubble with no work", async () => {
    const { finalTextIsReply } = await import("./loop-control.js");
    expect(finalTextIsReply([["read"], ["send_message"], []])).toBe(false);
  });
});

describe("claimsWorkInProgress", () => {
  it("spots a reply that says work is going on", async () => {
    const { claimsWorkInProgress } = await import("./loop-control.js");
    for (const text of [
      "Still in progress — the fix-and-render job is running now.",
      "🚀 Thanks — render's chugging along, I'll ping you the MP4 when it's verified.",
      "I've restarted the render with a tighter task and it's running now.",
      "Yes, still going. I'm fixing that and re-rendering now.",
      "Creator is on it — they acknowledged the full brief.",
    ]) {
      expect([text, claimsWorkInProgress(text)]).toEqual([text, true]);
    }
  });

  it("leaves finished results and plain answers alone", async () => {
    const { claimsWorkInProgress } = await import("./loop-control.js");
    for (const text of [
      "The video is done, here it is.",
      "It stopped before it finished. Tell me to continue.",
      "Pretty good, you?",
      "",
    ]) {
      expect([text, claimsWorkInProgress(text)]).toEqual([text, false]);
    }
  });
});

describe("announcesUnsentCard", () => {
  it("catches a card written as text, and leaves ordinary replies alone", async () => {
    const { announcesUnsentCard } = await import("./loop-control.js");
    expect(announcesUnsentCard("Great, let me ask a quick one.\n\n[widget:question]")).toBe(true);
    expect(announcesUnsentCard('(Shown to the person as a tappable question card: "When?" Choices: A | B.)')).toBe(true);
    expect(announcesUnsentCard("Here is the plan (in three parts).")).toBe(false);
  });
});

describe("asksInPlainText", () => {
  it("sees a closing question or a lead-in to choices, not a plain statement", async () => {
    const { asksInPlainText } = await import("./loop-control.js");
    expect(asksInPlainText("Got it. Quick one more: what would you most like to hand off first?")).toBe(true);
    expect(asksInPlainText("Sorry, let me make this easier. Pick what sounds closest:")).toBe(true);
    expect(asksInPlainText("Done, Scout is set up and has its own chat.")).toBe(false);
  });
});

describe("stripLeakedToolCall", () => {
  it("cuts a tool call written into the reply, and leaves ordinary text alone", async () => {
    const { stripLeakedToolCall, stripLeakedThinking } = await import("./loop-control.js");
    expect(stripLeakedToolCall("Publishing now; I'll drop you the link.spawn_worker<arg_key>instructions</arg_key><arg_value>Publish ONE post")).toBe(
      "Publishing now; I'll drop you the link.",
    );
    expect(stripLeakedToolCall('On it — no link field.spawn_worker spr подготовки {"task": "Edit two entries"}')).toBe("On it — no link field.");
    expect(stripLeakedToolCall("Done.<tool_call>read_file")).toBe("Done.");
    expect(stripLeakedThinking('Checking now. browser_open {"url": "x"}')).toBe("Checking now.");
    for (const plain of [
      "The file_name is report.md and the JSON looks like {a: 1}.",
      "Use the `snake_case` style {like this} for keys.",
      "I set max_steps to 60 for the job.",
    ]) {
      expect(stripLeakedToolCall(plain)).toBe(plain);
    }
  });
});

describe("stripLeakedThinking", () => {
  it("drops a long opening note to self and keeps ordinary brackets", async () => {
    const { stripLeakedThinking } = await import("./loop-control.js");
    const note = `(Let me think about what just happened. The person wants a team (niche, video). ${"I should suggest options. ".repeat(10)})`;
    expect(stripLeakedThinking(`${note}No worries, here are some ideas.`)).toBe("No worries, here are some ideas.");
    expect(stripLeakedThinking("(By the way) the report is ready.")).toBe("(By the way) the report is ready.");
    expect(stripLeakedThinking("All good (let me know if not).")).toBe("All good (let me know if not).");
  });
});

describe("what the person is told when a turn fails", () => {
  it("names the provider's answer, says what to check, and never shows a key", async () => {
    const { turnFailureText } = await import("./speaker.js");
    const refused = Object.assign(new Error("Incorrect API key provided: sk-proj-abcdefghijklmnop1234. Bearer abcdefghijklmnopqrstu"), { statusCode: 401 });
    const text = turnFailureText(refused);
    expect(text).toContain("(401)");
    expect(text).toContain("check the provider key");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(turnFailureText(Object.assign(new Error("No endpoints found for x/y"), { statusCode: 404 }))).toContain("check the model id");
    expect(turnFailureText(Object.assign(new Error("Insufficient credits"), { statusCode: 402 }))).toContain("no credit left");
  });

  it("does not blame the provider for a failure on the server", async () => {
    const { turnFailureText } = await import("./speaker.js");
    const text = turnFailureText(new Error("connect ECONNREFUSED /var/run/docker.sock"));
    expect(text).toContain("something failed on the server");
    expect(text).toContain("docker.sock");
    expect(text).not.toContain("provider");
  });
});
