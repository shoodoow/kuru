import { agentCreateSchema } from "@kuru/shared";

export const acceptedAgentFields = agentCreateSchema.keyof().options;
