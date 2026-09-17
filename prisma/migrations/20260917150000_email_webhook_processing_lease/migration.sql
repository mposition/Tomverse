-- The processing state of a stored provider event: a fenced lease, a bounded
-- number of attempts, and abandonment, so an event whose application failed is
-- retried -- by a provider redelivery or by the sweeper -- instead of being
-- answered as a duplicate forever.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (webhook reprocessing, C37, C47, C48, C74, C78).
--
-- Existing rows keep their state: processed rows stay processed, and rows that
-- failed before this change start at zero attempts and become the sweeper's.
-- The CHECKs are added NOT VALID and validated in their own statements.

ALTER TABLE "ProviderWebhookEvent"
    ADD COLUMN "processingLeaseId" TEXT,
    ADD COLUMN "processingStartedAt" TIMESTAMP(3),
    ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "abandonedAt" TIMESTAMP(3);

ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_terminal_check"
    CHECK ("processedAt" IS NULL OR "abandonedAt" IS NULL) NOT VALID;
ALTER TABLE "ProviderWebhookEvent" VALIDATE CONSTRAINT "ProviderWebhookEvent_terminal_check";

ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_lease_check"
    CHECK (("processingLeaseId" IS NULL) = ("processingStartedAt" IS NULL)) NOT VALID;
ALTER TABLE "ProviderWebhookEvent" VALIDATE CONSTRAINT "ProviderWebhookEvent_lease_check";

ALTER TABLE "ProviderWebhookEvent" ADD CONSTRAINT "ProviderWebhookEvent_attempts_check"
    CHECK ("processingAttempts" BETWEEN 0 AND 10) NOT VALID;
ALTER TABLE "ProviderWebhookEvent" VALIDATE CONSTRAINT "ProviderWebhookEvent_attempts_check";

CREATE INDEX "ProviderWebhookEvent_processedAt_abandonedAt_receivedAt_idx"
    ON "ProviderWebhookEvent"("processedAt", "abandonedAt", "receivedAt");
