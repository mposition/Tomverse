-- Catalog-import approval rows only. This migration inserts no cards,
-- promotes nothing out of backlog, and does not enable apply.

BEGIN;

CREATE TABLE "AmuxBoardImportApproval" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "canonicalizerVersion" TEXT NOT NULL,
    "sourceCommit" TEXT NOT NULL,
    "boardDigest" TEXT NOT NULL,
    "sourceVerificationMode" TEXT NOT NULL,
    "sourceAttestedAt" TIMESTAMP(3) NOT NULL,
    "activeItemCount" INTEGER NOT NULL,
    "sectionCount" INTEGER NOT NULL,
    "recommendationReferenceCount" INTEGER NOT NULL,
    "createKeys" JSONB NOT NULL,
    "noOpKeys" JSONB NOT NULL,
    "conflictKeys" JSONB NOT NULL,
    "excludeKeys" JSONB NOT NULL,
    "executionBriefDigests" JSONB NOT NULL,
    "itemBindings" JSONB NOT NULL,
    "itemBindingsDigest" TEXT NOT NULL,
    "plannerVersion" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "scannerRulesetDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "rawBodyDigest" TEXT NOT NULL,
    "outcomeUnknownAt" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxBoardImportApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxBoardImportApproval"
    ADD CONSTRAINT "AmuxBoardImportApproval_status_check"
    CHECK ("status" IN ('prepared', 'approved', 'rejected', 'expired', 'consumed'));

ALTER TABLE "AmuxBoardImportApproval"
    ADD CONSTRAINT "AmuxBoardImportApproval_actor_check"
    CHECK (char_length("actorUserId") > 0),
    ADD CONSTRAINT "AmuxBoardImportApproval_mode_check"
    CHECK ("sourceVerificationMode" = 'operator_attested'),
    ADD CONSTRAINT "AmuxBoardImportApproval_canonicalizer_check"
    CHECK ("canonicalizerVersion" = 'amux-json-v1'),
    ADD CONSTRAINT "AmuxBoardImportApproval_scanner_check"
    CHECK ("scannerVersion" = 'amux-board-content-scan-v1'),
    ADD CONSTRAINT "AmuxBoardImportApproval_policy_check"
    CHECK ("policyVersion" = 2),
    ADD CONSTRAINT "AmuxBoardImportApproval_digest_check"
    CHECK (
        "manifestDigest" ~ '^[a-f0-9]{64}$' AND
        "boardDigest" ~ '^[a-f0-9]{64}$' AND
        "scannerRulesetDigest" ~ '^[a-f0-9]{64}$' AND
        "rawBodyDigest" ~ '^[a-f0-9]{64}$' AND
        "itemBindingsDigest" ~ '^[a-f0-9]{64}$' AND
        "sourceCommit" ~ '^[a-f0-9]{40}$'
    ),
    ADD CONSTRAINT "AmuxBoardImportApproval_counts_check"
    CHECK (
        "activeItemCount" >= 0 AND
        "sectionCount" >= 0 AND
        "recommendationReferenceCount" >= 0
    ),
    ADD CONSTRAINT "AmuxBoardImportApproval_json_check"
    CHECK (
        jsonb_typeof("createKeys") = 'array' AND
        jsonb_typeof("noOpKeys") = 'array' AND
        jsonb_typeof("conflictKeys") = 'array' AND
        jsonb_typeof("excludeKeys") = 'array' AND
        jsonb_typeof("executionBriefDigests") = 'array' AND
        jsonb_typeof("itemBindings") = 'array'
    );

CREATE UNIQUE INDEX "AmuxBoardImportApproval_authorizationAuditLogId_key"
    ON "AmuxBoardImportApproval"("authorizationAuditLogId");

CREATE INDEX "AmuxBoardImportApproval_status_expiresAt_idx"
    ON "AmuxBoardImportApproval"("status", "expiresAt");

CREATE INDEX "AmuxBoardImportApproval_actorUserId_createdAt_idx"
    ON "AmuxBoardImportApproval"("actorUserId", "createdAt");

COMMIT;
