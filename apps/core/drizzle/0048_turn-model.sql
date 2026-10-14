-- The model a chat turn ran on, recorded when it finishes. Before this the
-- usage page guessed from the agent's current model, which counted old turns
-- against whatever model the agent was switched to later.
ALTER TABLE "runs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_id" text;
