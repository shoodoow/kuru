-- More reactions, including ones that say a result was not good.
ALTER TABLE "reactions" DROP CONSTRAINT IF EXISTS "reactions_emoji_check";--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_emoji_check" CHECK ("reactions"."emoji" in ('👍', '❤️', '🔥', '🎉', '👏', '🙏', '💯', '😂', '✅', '🚀', '👎', '😡', '😢', '❌', '👀', '😮', '🤔'));
