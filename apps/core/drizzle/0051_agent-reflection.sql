-- When each agent last reflected on its day, so the nightly reflection runs once a day per agent.
ALTER TABLE "agents" ADD COLUMN "reflected_at" timestamp with time zone;
