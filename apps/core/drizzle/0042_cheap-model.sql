-- The account's cheap model: optional, used for background workers, while chat
-- agents keep their own model. Null means each worker uses its agent's model.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "cheap_provider" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "cheap_model_id" text;
