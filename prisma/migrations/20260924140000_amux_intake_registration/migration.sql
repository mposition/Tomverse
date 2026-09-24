-- Intake registration evidence. This migration inserts no card, no draft
-- and no approval. The apply latch stays off, so production does not write
-- through the new tables until a later approval.

BEGIN;

CREATE TABLE "AmuxIntakeDraft" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "draftDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "title" TEXT,
    "scope" TEXT,
    "completion" TEXT,
    "workItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIntakeDraft_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxIntakeDraft"
    ADD CONSTRAINT "AmuxIntakeDraft_sourceSystem_sourceKey_key"
        UNIQUE ("sourceSystem", "sourceKey"),
    ADD CONSTRAINT "AmuxIntakeDraft_status_check"
        CHECK ("status" IN ('consumed', 'rejected', 'expired')),
    ADD CONSTRAINT "AmuxIntakeDraft_policy_version_check"
        CHECK ("policyVersion" = 1),
    ADD CONSTRAINT "AmuxIntakeDraft_digest_check"
        CHECK ("draftDigest" ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT "AmuxIntakeDraft_source_key_check"
        CHECK (
            "sourceSystem" = 'codex-conversation' AND
            "sourceKey" ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND
            "sourceVersion" ~ '^[!-~]+$'
        ),
    ADD CONSTRAINT "AmuxIntakeDraft_body_absent_check"
        CHECK ("title" IS NULL AND "scope" IS NULL AND "completion" IS NULL);

CREATE INDEX "AmuxIntakeDraft_status_expiresAt_idx"
    ON "AmuxIntakeDraft"("status", "expiresAt");

CREATE INDEX "AmuxIntakeDraft_actorUserId_createdAt_idx"
    ON "AmuxIntakeDraft"("actorUserId", "createdAt");

ALTER TABLE "AmuxIntakeDraft"
    ADD CONSTRAINT "AmuxIntakeDraft_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AmuxIntakeDraft"
    VALIDATE CONSTRAINT "AmuxIntakeDraft_workItemId_fkey";

CREATE TABLE "AmuxIntakeApproval" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "draftDigest" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "cardCount" INTEGER NOT NULL,
    "workItemId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxIntakeApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxIntakeApproval"
    ADD CONSTRAINT "AmuxIntakeApproval_authorizationAuditLogId_key"
        UNIQUE ("authorizationAuditLogId"),
    ADD CONSTRAINT "AmuxIntakeApproval_status_check"
        CHECK ("status" IN ('consumed', 'outcome_unknown')),
    ADD CONSTRAINT "AmuxIntakeApproval_policy_version_check"
        CHECK ("policyVersion" = 1),
    ADD CONSTRAINT "AmuxIntakeApproval_card_count_check"
        CHECK ("cardCount" = 1),
    ADD CONSTRAINT "AmuxIntakeApproval_digest_check"
        CHECK (
            "draftDigest" ~ '^[a-f0-9]{64}$' AND
            "sourceDigest" ~ '^[a-f0-9]{64}$'
        );

CREATE INDEX "AmuxIntakeApproval_status_createdAt_idx"
    ON "AmuxIntakeApproval"("status", "createdAt");

CREATE INDEX "AmuxIntakeApproval_actorUserId_createdAt_idx"
    ON "AmuxIntakeApproval"("actorUserId", "createdAt");

CREATE INDEX "AmuxIntakeApproval_workItemId_idx"
    ON "AmuxIntakeApproval"("workItemId");

ALTER TABLE "AmuxIntakeApproval"
    ADD CONSTRAINT "AmuxIntakeApproval_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AmuxIntakeApproval"
    VALIDATE CONSTRAINT "AmuxIntakeApproval_workItemId_fkey";

COMMIT;
