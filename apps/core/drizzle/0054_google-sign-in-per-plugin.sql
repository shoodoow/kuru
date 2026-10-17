-- Each Google plugin keeps its own sign-in, so YouTube can use a brand account and Gmail keeps its access.
-- account_google_oauth is left in place, unused, so an older release still finds its token after a rollback.
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "scopes" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "mcp_servers" AS m SET "secret" = g."secret", "scopes" = g."scopes"
  FROM "account_google_oauth" AS g
  WHERE m."account_id" = g."account_id" AND m."kind" = 'google';
