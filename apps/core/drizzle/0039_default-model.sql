-- The account's default model: chosen by the person during setup, used for the
-- default agent and offered first when a new agent is created.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "default_provider" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "default_model_id" text;
