-- Agent kinds: what an agent is for. 'work' does jobs on its own computer,
-- 'companion' is for conversation only, 'support' is the account's default
-- agent that sets the others up. Existing agents are work agents.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'work' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_kind_check"
    CHECK ("kind" in ('work', 'companion', 'support'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_one_support_per_account" ON "agents" ("account_id") WHERE "kind" = 'support';
--> statement-breakpoint
-- The account's brief: a standing page about the person and what they do,
-- written by the support agent and shown to every agent on every turn.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brief" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "brief_updated_at" timestamp with time zone;
