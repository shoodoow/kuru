-- A procedure is a rule for how a kind of work is done ("when you do Y, use X").
-- The agent's procedures go to every worker it starts.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_kind_check";--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_kind_check"
  CHECK ("kind" in ('fact', 'person', 'org', 'project', 'preference', 'decision', 'commitment', 'procedure', 'profile'));
