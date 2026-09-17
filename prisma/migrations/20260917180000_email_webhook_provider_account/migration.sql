-- The provider account each stored webhook event came through. Transactional
-- and marketing mail go out through separate Resend accounts, each with its
-- own webhook endpoint and signing secret; a message id is matched only within
-- the account that sent it.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (C56, C72).
--
-- Expand only. The previous build inserts without the column and resolves
-- conflicts on (provider, providerEventId), and it keeps serving webhooks while
-- this build rolls out, so both the default and that unique index stay. Every
-- event that build receives came through its one endpoint, which served the
-- transactional account, so the default is also the truth for it -- and for
-- every row stored before this change. Dropping the old index and the default
-- is a later migration, once no previous build remains.
--
-- ProviderWebhookEvent holds ninety days of events for a handful of accounts;
-- the index builds are short.

ALTER TABLE "ProviderWebhookEvent"
    ADD COLUMN "providerAccount" TEXT NOT NULL DEFAULT 'transactional';

ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_provider_account_check"
    CHECK ("providerAccount" IN ('transactional', 'marketing')) NOT VALID;
ALTER TABLE "ProviderWebhookEvent" VALIDATE CONSTRAINT "ProviderWebhookEvent_provider_account_check";

-- 63 bytes is PostgreSQL's identifier limit; the name is short enough to be
-- kept whole, so the violation names it exactly.
CREATE UNIQUE INDEX "ProviderWebhookEvent_account_event_key"
    ON "ProviderWebhookEvent"("provider", "providerAccount", "providerEventId");

-- Per-account silence reads one provider's last day of events for one account.
CREATE INDEX "ProviderWebhookEvent_provider_account_receivedAt_idx"
    ON "ProviderWebhookEvent"("provider", "providerAccount", "receivedAt");
