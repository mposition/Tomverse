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
-- matching that S1b-2b built reads it that way. Partial, because a delivery
-- that never reached the provider has no message id and there are many of
-- them; Postgres does not compare nulls, so those rows stay free.
--
-- **This one cannot be applied blind.** A unique index fails on the first
-- duplicate it meets, part-way through a deploy, and the answer lives in the
-- data rather than in this file. `npm run email:check-message-id-duplicates`
-- asks it read-only and prints counts.

-- The account-aware unique carries every read now
-- (ProviderWebhookEvent_account_event_key, added 20260917180000).
DROP INDEX IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";
ALTER TABLE "ProviderWebhookEvent"
    DROP CONSTRAINT IF EXISTS "ProviderWebhookEvent_provider_providerEventId_key";

-- One writer, and it names the account. A default here would let the next one
-- not name it.
ALTER TABLE "ProviderWebhookEvent" ALTER COLUMN "providerAccount" DROP DEFAULT;

-- Replaces the plain index of the same columns: the uniqueness is the point,
-- and keeping both would be two structures for one question.
DROP INDEX IF EXISTS "EmailDelivery_providerAccount_providerMessageId_idx";

CREATE UNIQUE INDEX "EmailDelivery_providerAccount_providerMessageId_key"
    ON "EmailDelivery"("providerAccount", "providerMessageId")
    WHERE "providerAccount" IS NOT NULL AND "providerMessageId" IS NOT NULL;
