-- Rule strength, and a journal of each reflection with its edits so it can be read and undone.
ALTER TABLE "memories" ADD COLUMN "confirmed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "tentative" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_reflections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "status" text NOT NULL,
  "health" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_reflections_agent_index" ON "agent_reflections" ("agent_id", "created_at");
