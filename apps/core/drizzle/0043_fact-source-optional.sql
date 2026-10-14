-- A fact can outlive the chat it was learned in: when an agent is removed, the
-- facts it learned about the person stay and only lose the link to their source.
ALTER TABLE "memories" ALTER COLUMN "message_id" DROP NOT NULL;
