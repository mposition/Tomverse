-- The default model leaves the database: no column default names a model.
--
-- UserSettings.defaultModel and Conversation.selectedModels carried defaults
-- that named the application default as of the last migration to move them
-- (20260801200000 to gpt-5-6-luna, 20261012090000 to gpt-6-luna). That was a
-- second copy of APP_DEFAULTS.defaultModelId (lib/appDefaults.ts), and every
-- default-model change needed a migration to move it. The code is now the only
-- copy: every writer names the value (step 3a), and
-- tests/userSettingsDefaultModelWriters.test.mjs plus the Prisma create types
-- -- which make both fields required once these defaults are gone -- keep it
-- that way.
--
-- Deploy order: only after a release whose writers already name both fields.
-- `prisma migrate deploy` runs while the previous deployment still serves, and
-- an instance from before step 3a would insert a row without the value and
-- fail on NOT NULL.
--
-- No existing row changes. Both columns stay NOT NULL; only the value a row
-- gets when an INSERT leaves the column out is removed.
--
-- Recovery, if a writer turns out to depend on the default after all:
--
--   ALTER TABLE "UserSettings" ALTER COLUMN "defaultModel" SET DEFAULT 'gpt-6-luna';
--   ALTER TABLE "Conversation" ALTER COLUMN "selectedModels" SET DEFAULT '["gpt-6-luna"]';
--
-- as a new migration, with schema.prisma moved back to match.

BEGIN;

-- Each statement takes ACCESS EXCLUSIVE on its table, and an ACCESS EXCLUSIVE
-- request queues ahead of new readers, so an unbounded wait behind one long
-- query would shut the table for everyone. The statements are catalogue edits
-- and take no time once the lock is held.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserSettings" ALTER COLUMN "defaultModel" DROP DEFAULT;

ALTER TABLE "Conversation" ALTER COLUMN "selectedModels" DROP DEFAULT;

COMMIT;
