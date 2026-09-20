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
-- delivery that never reached the provider conflicts with nothing -- and it
-- would cost the one thing that matters here: schema.prisma cannot express a
-- partial index, so `prisma db push` would not create it and `migrate diff`
-- would report drift on every run. 20260801190000_plan_change_pending_slot is
-- this same lesson, learned on a constraint that turned out not to exist in the
-- database the tests were written against.
--
-- **This one cannot be applied blind.** A unique index fails on the first
-- duplicate it meets, part-way through a deploy, and the answer lives in the
-- data rather than in this file. `npm run email:check-message-id-duplicates`
-- asks it read-only and prints counts. That reading is a reason to stop, never
-- a promise to go: it is taken before the deploy and a writer can add a
-- duplicate after it. The index build is the only statement that decides, so
-- this file is ordered so that its failure costs nothing but the deploy.
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

-- The account-aware unique carries every read now
-- (ProviderWebhookEvent_account_event_key, added 20260917180000).
--
-- 20260821090000 line 330 created this with `CREATE UNIQUE INDEX`, so in every
-- database built from this history it is an index and the DROP INDEX below is
-- the statement that removes it. The DROP CONSTRAINT is for a database that
-- got it some other way, and it comes first: if the object were a constraint,
-- `DROP INDEX` would fail on the dependency rather than skip it, and
-- `IF EXISTS` does not cover that.
ALTER TABLE "ProviderWebhookEvent"
    DROP CONSTRAINT IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";
DROP INDEX IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";

-- One writer, and it names the account. A default here would let the next one
-- not name it.
ALTER TABLE "ProviderWebhookEvent" ALTER COLUMN "providerAccount" DROP DEFAULT;

-- Build the unique index BEFORE dropping the plain one of the same columns.
--
-- The build is the statement that can fail -- on a duplicate written after the
-- check was taken -- and whether this file runs inside a transaction decides
-- nothing here: if it does, the failure rolls the whole thing back; if it does
-- not, the failure stops before the DROP is reached. Either way the plain index
-- is still there afterwards, and the webhook matcher does not start sequentially
-- scanning `EmailDelivery` because a deploy failed.
--
-- `IF NOT EXISTS` is how an operator may build it `CONCURRENTLY` beforehand.
-- The build takes an ACCESS EXCLUSIVE lock on `EmailDelivery` for its duration,
-- and `CONCURRENTLY` cannot be used here -- Postgres refuses it inside a
-- transaction block, and this file may be running in one. When the row count
-- from `email:check-message-id-duplicates` makes that lock unacceptable, the
-- index is created by hand, outside any transaction, with exactly this name and
-- these columns, and this statement then finds it and does nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "EmailDelivery_providerAccount_providerMessageId_key"
    ON "EmailDelivery"("providerAccount", "providerMessageId");

-- ...which means the name alone must not be taken as proof. A pre-built index
-- that is partial, or not unique, or on other columns, would satisfy
-- `IF NOT EXISTS` and leave the guarantee absent, so it is read back here.
DO $
DECLARE
    correct boolean;
BEGIN
    SELECT i.indisunique
       AND i.indpred IS NULL
       AND (
             SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a
                 ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           ) = ARRAY['providerAccount', 'providerMessageId']
      INTO correct
      FROM pg_index i
      JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_class tb ON tb.oid = i.indrelid
     WHERE ix.relname = 'EmailDelivery_providerAccount_providerMessageId_key'
       AND tb.relname = 'EmailDelivery';

    IF correct IS DISTINCT FROM true THEN
        RAISE EXCEPTION
            'EmailDelivery_providerAccount_providerMessageId_key must be a non-partial UNIQUE index on ("providerAccount", "providerMessageId")';
    END IF;
END $;

-- Only now: the plain index of the same columns answered the same question and
-- the unique one answers it with a guarantee. Keeping both would be two
-- structures for one question.
DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";
