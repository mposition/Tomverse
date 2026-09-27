-- Manual promotion evidence and brief columns. This migration updates no
-- card status, inserts no approval, and does not enable the apply latch.

BEGIN;

ALTER TABLE "AmuxWorkItem"
    ADD COLUMN "executionBrief" TEXT,
    ADD COLUMN "executionBriefDigest" TEXT;

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_execution_brief_pair_check"
        CHECK (
            (
                "executionBrief" IS NULL AND
                "executionBriefDigest" IS NULL
            ) OR (
                "executionBrief" IS NOT NULL AND
                octet_length("executionBrief") BETWEEN 1 AND 8192 AND
                "executionBriefDigest" IS NOT NULL AND
                "executionBriefDigest" ~ '^[a-f0-9]{64}$'
            )
        ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_sourced_todo_has_brief_check"
        CHECK (
            "status" <> 'todo' OR
            "sourceSystem" IS NULL OR
            "executionBrief" IS NOT NULL
        ) NOT VALID;

ALTER TABLE "AmuxWorkItem"
    VALIDATE CONSTRAINT "AmuxWorkItem_execution_brief_pair_check";

ALTER TABLE "AmuxWorkItem"
    VALIDATE CONSTRAINT "AmuxWorkItem_sourced_todo_has_brief_check";

CREATE TABLE "AmuxBoardPromotionApproval" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "rawBodyDigest" TEXT NOT NULL,
    "itemBindings" JSONB NOT NULL,
    "itemBindingsDigest" TEXT NOT NULL,
    "cardCount" INTEGER NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "scannerRulesetDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "outcomeUnknownAt" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxBoardPromotionApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxBoardPromotionApproval"
    ADD CONSTRAINT "AmuxBoardPromotionApproval_authorizationAuditLogId_key"
        UNIQUE ("authorizationAuditLogId"),
    ADD CONSTRAINT "AmuxBoardPromotionApproval_status_check"
        CHECK ("status" IN ('prepared', 'approved', 'rejected', 'expired', 'consumed')),
    ADD CONSTRAINT "AmuxBoardPromotionApproval_card_count_check"
        CHECK ("cardCount" BETWEEN 1 AND 3),
    ADD CONSTRAINT "AmuxBoardPromotionApproval_policy_version_check"
        CHECK ("policyVersion" = 3),
    ADD CONSTRAINT "AmuxBoardPromotionApproval_digest_check"
        CHECK (
            "requestDigest" ~ '^[a-f0-9]{64}$' AND
            "rawBodyDigest" ~ '^[a-f0-9]{64}$' AND
            "itemBindingsDigest" ~ '^[a-f0-9]{64}$' AND
            "scannerRulesetDigest" ~ '^[a-f0-9]{64}$'
        );

CREATE INDEX "AmuxBoardPromotionApproval_status_expiresAt_idx"
    ON "AmuxBoardPromotionApproval"("status", "expiresAt");

CREATE INDEX "AmuxBoardPromotionApproval_actorUserId_createdAt_idx"
    ON "AmuxBoardPromotionApproval"("actorUserId", "createdAt");

COMMIT;
