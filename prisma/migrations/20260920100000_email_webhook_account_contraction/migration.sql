-- The contraction the account split left owing.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.4
-- (C56, C72), docs/policy/email-notifications.md section 9.8.
--
-- 20260917180000 was expand-only: it added `providerAccount`, gave it a default
-- so the build before it could keep inserting without the column, and left the
-- old `(provider, providerEventId)` unique in place so that build's conflict
-- resolution kept working. Both were scaffolding for a rollout that is over --
-- the account-aware build has been live since 2026-09-17 -- and each of them
-- is now a way to be wrong:
--
--   * the old unique refuses a marketing event that happens to carry the same
--     provider event id as a transactional one. They are different events from
--     different accounts, and the account-aware unique is what says so;
--   * the default answers "which account did this come through" with a guess
--     for any writer that forgets to say. There is one writer and it always
--     says, and a default is how that stops being true without anyone noticing.
--
-- The `EmailDelivery` index becomes unique here for the same reason the webhook
-- one is: a message id identifies a delivery *within* an account, and the
-- matching that S1b-2b built reads it that way.
--
-- Plain, not partial. A `WHERE "providerAccount" IS NOT NULL AND
-- "providerMessageId" IS NOT NULL` predicate would enforce exactly what a plain
-- unique index already enforces -- Postgres does not compare nulls, so a
-- delivery that never reached the provider conflicts with nothing. Prisma can
-- express a partial index since 7.4, but only behind the `partialIndexes`
-- preview feature, and this schema enables no preview features at all. Turning
-- one on is a commitment across the whole schema; the predicate would buy
-- nothing for it, and without it `prisma db push` would not create the index
-- and `migrate diff` would call it drift on every run.
-- 20260801190000_plan_change_pending_slot is this same lesson, learned on a
-- constraint that turned out not to exist in the database its test was written
-- against.
--
-- **This one cannot be applied blind.** A unique index fails on the first
-- duplicate it meets, part-way through a deploy, and the answer lives in the
-- data rather than in this file. `npm run email:check-message-id-duplicates`
-- asks it read-only and prints counts. That reading is a reason to stop, never
-- a promise to go: it is taken before the deploy and a writer can add a
-- duplicate after it. The build is the only statement here that can fail on
-- data, so it goes first.
--
-- **Rollback floor: the commit that introduced 20260917180000** (the
-- account-aware build, live since 2026-09-17). Below it this schema is not
-- merely degraded, it refuses work: that build inserts a webhook event without
-- naming the account and relies on the default this migration drops, so every
-- `ProviderWebhookEvent` insert fails `NOT NULL`, and its conflict handling
-- names `(provider, providerEventId)`, whose unique this migration drops. The
-- cost is every inbound webhook rejected and bounce and complaint handling
-- stopped for the length of the rollback. A rollback that has to go further
-- back than the floor reverts this migration first:
--
--   ALTER TABLE "ProviderWebhookEvent"
--       ALTER COLUMN "providerAccount" SET DEFAULT 'transactional';
--   CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_providerEventId_key"
--       ON "ProviderWebhookEvent"("provider", "providerEventId");
--
-- -- and that CREATE can itself fail, on exactly the cross-account collision
-- the account-aware unique exists to allow. It is a recovery, not a routine.

-- ---------------------------------------------------------------------------
-- All of it, or none of it.
--
-- `prisma migrate deploy` does not wrap a migration file in a transaction, so
-- without this the file can half-apply: the index is built and committed, a
-- later statement fails on a lock timeout or a dropped connection, and the
-- migration is recorded as failed with the new index already in place. There is
-- then no good move. `migrate resolve --rolled-back` and re-run fails on the
-- first statement, because the index it wants to create exists; `--applied`
-- marks as done a migration whose remaining statements never ran, and which of
-- them ran depends on where it stopped. Recovery means reading the catalogue by
-- hand while cross-account webhooks keep being refused.
--
-- Every statement here is transactional DDL in Postgres, so the file says so
-- itself. A failure anywhere rolls the whole thing back, the migration is
-- recorded as failed with the database untouched, and re-running it after the
-- cause is fixed is an ordinary retry.
BEGIN;

-- The statement that can fail on data goes first.
--
-- Nothing has run before it, so its failure is the cheapest failure available:
-- a duplicate written after the check was taken costs the deploy and nothing
-- else.
--
-- No `IF NOT EXISTS`. It would let an index that merely shares this name stand
-- in for this one, and "merely shares the name" covers more than it sounds: an
-- index left INVALID by a failed `CREATE INDEX CONCURRENTLY`, one built NULLS
-- NOT DISTINCT, one carrying a third expression key. Each would satisfy the
-- name, skip the build, and then be relied on by the DROP below -- and a
-- catalogue check written to tell them apart is a second thing to get exactly
-- right. Failing loudly on the name is cheaper and needs nothing to be right.
--
-- The build itself takes a SHARE lock on `EmailDelivery`: reads continue,
-- writes wait. `CREATE INDEX CONCURRENTLY` would avoid even that and cannot be
-- used here -- Postgres refuses it inside a transaction block, and the BEGIN
-- above puts us firmly in one. `email:check-message-id-duplicates` prints the
-- row count, so the wait is judged before the deploy rather than during it.
CREATE UNIQUE INDEX "EmailDelivery_providerAccount_providerMessageId_key"
    ON "EmailDelivery"("providerAccount", "providerMessageId");

-- The account-aware unique carries every read now
-- (ProviderWebhookEvent_account_event_key, added 20260917180000).
--
-- 20260821090000 line 330 created this with `CREATE UNIQUE INDEX`, so in every
-- database built from this history it is an index and the DROP INDEX below is
-- the statement that removes it. The DROP CONSTRAINT is for a database that got
-- it some other way, and it comes first: if the object were a constraint,
-- `DROP INDEX` would fail on the dependency rather than skip it, and
-- `IF EXISTS` does not cover that.
ALTER TABLE "ProviderWebhookEvent"
    DROP CONSTRAINT IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";
DROP INDEX IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";

-- One writer, and it names the account. A default here would let the next one
-- not name it.
ALTER TABLE "ProviderWebhookEvent" ALTER COLUMN "providerAccount" DROP DEFAULT;

-- Last, because it is the one statement that takes ACCESS EXCLUSIVE on
-- `EmailDelivery`, and a lock taken inside a transaction is held until it
-- commits. Reads of that table stop here rather than at the start of the build,
-- which is the long part.
--
-- The plain index of the same columns answered the same question and the unique
-- one answers it with a guarantee; keeping both would be two structures for one
-- question.
DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";

COMMIT;
