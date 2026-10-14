-- The model a background job actually ran on. With a background model set it
-- differs from the agent's own, and usage is shown per model.
ALTER TABLE "delegations" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "delegations" ADD COLUMN "model_id" text;
