-- A daily spending limit per account, in estimated dollars. Null: no limit.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "daily_budget_usd" double precision;
