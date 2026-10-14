-- "Always allow": an action one agent may take without asking again, such as
-- Nora publishing reels on Instagram. Set from an approval card, removed from Approvals.
CREATE TABLE IF NOT EXISTS "tool_allowances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "tool" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_allowances_agent_tool_unique" UNIQUE ("account_id", "agent_id", "tool")
);
