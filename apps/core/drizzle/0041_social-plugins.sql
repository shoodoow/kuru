-- Instagram and TikTok plugins keep their own sign-in in their row, as kind
-- "social". Google plugins (YouTube among them) stay "google".
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_kind_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_kind_check" CHECK ("kind" in ('remote', 'google', 'social'));
