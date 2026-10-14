-- A routine can run as a worker: no chat turn first, the brief goes straight to
-- a worker on the background model. The worker keeps a notes file between runs.
ALTER TABLE "routines" ADD COLUMN "runs_as" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "worker_kind" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "worker_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "notes_path" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "brief_path" text;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_runs_as_check" CHECK ("routines"."runs_as" in ('agent', 'worker'));--> statement-breakpoint
-- The worker a run started, so its report becomes the run's result when it finishes.
ALTER TABLE "jobs" ADD COLUMN "delegation_id" uuid;
