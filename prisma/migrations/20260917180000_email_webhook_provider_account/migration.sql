-- The provider account each stored webhook event came through. Transactional
-- and marketing mail go out through separate Resend accounts, each with its
-- own webhook endpoint and signing secret; an event id is unique only within
-- its account, and a message id is matched only within the account that sent
-- it.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (C56, C72).
--
-- Every event stored before this change came through the one endpoint there
-- was, which served the transactional account, so they are backfilled as
-- transactional. The column keeps no default afterwards: every writer names
-- its account.
--
-- ProviderWebhookEvent holds ninety days of events and is small; the new
-- unique index is built before the old one is dropped so the replay guard is
-- never absent.

ALTER TABLE "ProviderWebhookEvent"
    ADD COLUMN "providerAccount" TEXT NOT NULL DEFAULT 'transactional';
ALTER TABLE "ProviderWebhookEvent" ALTER COLUMN "providerAccount" DROP DEFAULT;

ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_provider_account_check"
    CHECK ("providerAccount" IN ('transactional', 'marketing')) NOT VALID;
ALTER TABLE "ProviderWebhookEvent" VALIDATE CONSTRAINT "ProviderWebhookEvent_provider_account_check";

CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_providerAccount_providerEventId_key"
    ON "ProviderWebhookEvent"("provider", "providerAccount", "providerEventId");
DROP INDEX "ProviderWebhookEvent_provider_providerEventId_key";

-- Per-account silence reads the last day of events for one account.
CREATE INDEX "ProviderWebhookEvent_providerAccount_receivedAt_idx"
    ON "ProviderWebhookEvent"("providerAccount", "receivedAt");
