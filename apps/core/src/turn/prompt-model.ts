/**
 * Maps turn input to AI SDK instructions + message list.
 * Why: provider cache breakpoints stay in one place. DB: none.
 */
import type { ModelMessage, SystemModelMessage } from "ai";
import type { TurnInput } from "./types.js";
import type { TurnMessageContent } from "./prompt-media.js";
import { cachedSystem } from "../model/cache-hints.js";

export function toModelPrompt(input: Pick<TurnInput, "provider" | "prefix" | "tail" | "messages">): {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
} {
  return {
    instructions: [cachedSystem(input.provider, input.prefix), { role: "system", content: input.tail }],
    messages: input.messages as ModelMessage[],
  };
}

export type { TurnMessageContent };
