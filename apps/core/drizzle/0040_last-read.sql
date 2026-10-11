-- When the person last had this chat open. Agent messages newer than it count
-- as unread in the inbox. Existing chats start as read.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "conversations" SET "last_read_at" = now() WHERE "last_read_at" IS NULL;
