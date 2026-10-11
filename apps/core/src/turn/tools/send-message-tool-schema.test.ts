import { describe, expect, it } from "vitest";
import { sendMessageInputSchema } from "@kuru/agent-tools";

describe("send_message tool shape", () => {
  it("accepts canonical text blocks", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [{ kind: "text", markdown: "Still processing the desktop screenshot..." }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects blocks missing kind (model failure mode from traces)", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [{ "": "Still processing the desktop screenshot..." }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects text field without kind markdown", () => {
    expect(sendMessageInputSchema.safeParse({ blocks: [{ kind: "text", text: "hi" }] }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ blocks: [{ text: "hi" }] }).success).toBe(false);
  });

  it("accepts a question widget", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [
        {
          kind: "widget",
          widget: "question",
          props: {
            prompt: "Ship it?",
            options: [
              { label: "Yes", value: "yes", style: "primary" },
              { label: "No", value: "no", style: "danger" },
            ],
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a desktop-handover widget", () => {
    const parsed = sendMessageInputSchema.safeParse({
      blocks: [
        {
          kind: "widget",
          widget: "desktop-handover",
          props: { message: "Sign in to Instagram, then tell me to continue.", buttonLabel: "Take over" },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
