import type { AgentCreate } from "@kuru/shared";
import type { agents } from "./schema.js";

type AgentRow = typeof agents.$inferInsert;

/**
 * Proves the agent table can store every field the API accepts.
 * Input: none. This value is never called.
 * Output: a type that fails compilation if an API field is missing from the row.
 */
const agentFieldsMatchApi = null as unknown as {
  [Field in keyof AgentCreate]: AgentRow[Field];
};

void agentFieldsMatchApi;
