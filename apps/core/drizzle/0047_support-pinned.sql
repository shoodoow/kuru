-- The Chief of Staff always stays pinned and visible; the app no longer offers to change either.
UPDATE "agents" SET "pinned" = true, "hidden" = false WHERE "kind" = 'support';
