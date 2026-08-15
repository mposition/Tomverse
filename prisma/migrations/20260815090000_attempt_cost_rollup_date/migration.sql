-- The day a cost row was rolled up on, stored rather than inferred.
--
-- A correction is applied as a delta to the `ProviderDailyUsage` row the base
-- row already moved, so it has to find that row. It was finding it with
-- `DATE_TRUNC('day', "createdAt")` -- which is a guess, and a wrong one across
-- a UTC midnight: the base rollup's day comes from the application's clock at
-- the moment it wrote, and `createdAt` comes from the database's own `now()`.
-- Skew of a few milliseconds either side of midnight puts them on different
-- days, and the correction then updates a row that does not exist, silently.
--
-- Stored once and read by both, the question stops being a question.
ALTER TABLE "ChatAttemptUsage" ADD COLUMN "rollupDate" TIMESTAMP(3);

-- Existing rows: their rollup used the same clock read that produced
-- `createdAt` within the same statement, so truncating it recovers the day
-- they actually landed on. This is the last time that inference is made.
--
-- The immutability trigger refuses every UPDATE, including this one, so it is
-- disabled for the length of the backfill. The rule it enforces is about what
-- application code may do to a settled row, not about a migration adding a
-- column that did not exist when the row was written.
ALTER TABLE "ChatAttemptUsage" DISABLE TRIGGER "chat_attempt_usage_is_immutable";
UPDATE "ChatAttemptUsage"
SET "rollupDate" = DATE_TRUNC('day', "createdAt")
WHERE "rollupDate" IS NULL;
ALTER TABLE "ChatAttemptUsage" ENABLE TRIGGER "chat_attempt_usage_is_immutable";

ALTER TABLE "ChatAttemptUsage" ALTER COLUMN "rollupDate" SET NOT NULL;

-- Midnight UTC, like `ProviderDailyUsage.date`, so the two join on equality
-- rather than on a truncation somebody has to remember to apply.
ALTER TABLE "ChatAttemptUsage"
    ADD CONSTRAINT "ChatAttemptUsage_rollupDate_midnight_check"
    CHECK ("rollupDate" = DATE_TRUNC('day', "rollupDate"));
