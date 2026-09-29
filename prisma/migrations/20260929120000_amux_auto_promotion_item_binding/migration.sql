-- Orchestration policy version 15, "자동 승격 개정". Additive only.
--
-- A grant binds one promotion item and one cent amount. The three columns are
-- nullable so the migration is additive: a legacy row keeps all three null and
-- the system tick never consumes it. The pair check keeps a row from carrying
-- part of a binding, and the amount check matches the one-event cost cap.
--
-- AmuxRecommendationAutoUnknown records a consume whose outcome the caller lost,
-- after a read-back. It stores no user id; its actor is on the linked audit row.
--
-- This migration writes no row, changes no card, inserts no capacity row, and
-- does not read or set an environment value.

ALTER TABLE "AmuxRecommendationAutoGrant"
  ADD COLUMN "itemBindings" JSONB,
  ADD COLUMN "itemBindingsDigest" TEXT,
  ADD COLUMN "amountCents" INTEGER;

ALTER TABLE "AmuxRecommendationAutoGrant"
  ADD CONSTRAINT "AmuxRecommendationAutoGrant_amount_check"
    CHECK ("amountCents" IS NULL OR "amountCents" BETWEEN 1 AND 500),
  ADD CONSTRAINT "AmuxRecommendationAutoGrant_binding_pair_check"
    CHECK (
      ("itemBindings" IS NULL AND "itemBindingsDigest" IS NULL AND "amountCents" IS NULL) OR
      ("itemBindings" IS NOT NULL AND "itemBindingsDigest" IS NOT NULL AND "amountCents" IS NOT NULL)
    );

CREATE TABLE "AmuxRecommendationAutoUnknown" (
    "id" TEXT NOT NULL,
    "grantId" TEXT,
    "consumptionFound" BOOLEAN NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxRecommendationAutoUnknown_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AmuxRecommendationAutoUnknown_authorizationAuditLogId_key"
  ON "AmuxRecommendationAutoUnknown"("authorizationAuditLogId");
CREATE INDEX "AmuxRecommendationAutoUnknown_grantId_idx"
  ON "AmuxRecommendationAutoUnknown"("grantId");
CREATE INDEX "AmuxRecommendationAutoUnknown_recordedAt_idx"
  ON "AmuxRecommendationAutoUnknown"("recordedAt");

ALTER TABLE "AmuxRecommendationAutoUnknown"
  ADD CONSTRAINT "AmuxRecommendationAutoUnknown_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "AmuxRecommendationAutoGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
