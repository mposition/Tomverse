-- Local intake normalized analysis. This migration inserts no card.
-- The apply latch ships false, so the public route does not write these
-- tables until a later environment approval.

BEGIN;

CREATE TABLE "AmuxLocalIntakeNormalized" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "normalizedDigest" TEXT NOT NULL,
    "packageDigest" TEXT NOT NULL,
    "snapshotDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "normalized" JSONB NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxLocalIntakeNormalized_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxLocalIntakeNormalized"
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_workItemId_key" UNIQUE ("workItemId"),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_sourceSystem_sourceKey_key"
        UNIQUE ("sourceSystem", "sourceKey"),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_source_system_check"
        CHECK ("sourceSystem" = 'local-agent-intake'),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_policy_version_check"
        CHECK ("policyVersion" = 3),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_schema_version_check"
        CHECK ("schemaVersion" = 1),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_priority_check"
        CHECK ("priority" IN ('p0', 'p1', 'p2', 'p3')),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_digest_check"
        CHECK (
            "normalizedDigest" ~ '^[a-f0-9]{64}$' AND
            "packageDigest" ~ '^[a-f0-9]{64}$' AND
            "snapshotDigest" ~ '^[a-f0-9]{64}$'
        ),
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_object_check"
        CHECK (jsonb_typeof("normalized") = 'object');

CREATE INDEX "AmuxLocalIntakeNormalized_actorUserId_createdAt_idx"
    ON "AmuxLocalIntakeNormalized"("actorUserId", "createdAt");

ALTER TABLE "AmuxLocalIntakeNormalized"
    ADD CONSTRAINT "AmuxLocalIntakeNormalized_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AmuxLocalIntakeNormalized"
    VALIDATE CONSTRAINT "AmuxLocalIntakeNormalized_workItemId_fkey";

CREATE TABLE "AmuxLocalIntakeApproval" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxLocalIntakeApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmuxLocalIntakeApproval"
    ADD CONSTRAINT "AmuxLocalIntakeApproval_authorizationAuditLogId_key"
        UNIQUE ("authorizationAuditLogId"),
    ADD CONSTRAINT "AmuxLocalIntakeApproval_status_check"
        CHECK ("status" IN ('consumed', 'outcome_unknown')),
    ADD CONSTRAINT "AmuxLocalIntakeApproval_policy_version_check"
        CHECK ("policyVersion" = 3),
    ADD CONSTRAINT "AmuxLocalIntakeApproval_card_count_check"
        CHECK ("cardCount" = 1),
    ADD CONSTRAINT "AmuxLocalIntakeApproval_digest_check"
        CHECK (
            "draftDigest" ~ '^[a-f0-9]{64}$' AND
            "sourceDigest" ~ '^[a-f0-9]{64}$'
        );

CREATE INDEX "AmuxLocalIntakeApproval_status_createdAt_idx"
    ON "AmuxLocalIntakeApproval"("status", "createdAt");

CREATE INDEX "AmuxLocalIntakeApproval_actorUserId_createdAt_idx"
    ON "AmuxLocalIntakeApproval"("actorUserId", "createdAt");

CREATE INDEX "AmuxLocalIntakeApproval_workItemId_idx"
    ON "AmuxLocalIntakeApproval"("workItemId");

ALTER TABLE "AmuxLocalIntakeApproval"
    ADD CONSTRAINT "AmuxLocalIntakeApproval_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "AmuxLocalIntakeApproval"
    VALIDATE CONSTRAINT "AmuxLocalIntakeApproval_workItemId_fkey";

COMMIT;
