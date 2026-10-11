import { describe, expect, it } from "vitest";

describe("replaySentCards", () => {
  const card = {
    id: "11111111-2222-3333-4444-555555555555",
    agentId: "me",
    body: "(a card)",
    payload: [
      { kind: "text", markdown: "Got it." },
      { kind: "widget", widget: "question", props: { prompt: "What do you sell?", options: [{ label: "Soap" }], selected: "Soap" } },
    ],
  };
  const reader = { selfId: "me", names: new Map<string, string>() };

  it("replays the agent's own card as the send_message call it was, with the person's answer as the result", async () => {
    const { replaySentCards, toModelMessages } = await import("./prompt-media.js");
    const messages = replaySentCards(
      toModelMessages([{ agentId: null, body: "hi", payload: null }, card], undefined, undefined, undefined, reader),
    ) as unknown as { role: string; content: unknown }[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    const call = (messages[1]!.content as { type: string; toolName: string; toolCallId: string; input: { blocks: { props?: object }[] } }[])[0]!;
    expect(call).toMatchObject({ type: "tool-call", toolName: "send_message" });
    // The answer is not part of what the agent sent; it comes back in the result.
    expect(JSON.stringify(call.input)).not.toContain("selected");
    const result = (messages[2]!.content as { toolCallId: string; output: { value: { answer: string } } }[])[0]!;
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.output.value.answer).toBe("Soap");
    // Nothing in the history describes the card in words the model could copy.
    expect(JSON.stringify(messages)).not.toContain("Shown to the person");
  });

  it("leaves another agent's card and plain messages as text, and shows app-posted cards as notes", async () => {
    const { replaySentCards, toModelMessages } = await import("./prompt-media.js");
    const appCard = { id: "a", agentId: "me", body: "(agent card)", payload: [{ kind: "widget", widget: "agent-card", props: { label: "Scout" } }] };
    const messages = replaySentCards(
      toModelMessages([{ ...card, agentId: "someone-else" }, { agentId: "me", body: "Done.", payload: null }, appCard], undefined, undefined, undefined, reader),
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(String(messages[2]!.content)).toContain("[app note]");
  });
});
