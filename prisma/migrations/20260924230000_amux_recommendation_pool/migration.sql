-- Recommendation pool storage. This migration inserts no capacity row, writes no
-- card, and does not enable the recommendation latch.

CREATE TABLE "AmuxRecommendationCapacity" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "wipLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationCapacity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationCapacity_id_check" CHECK ("id" IN ('queue')),
    CONSTRAINT "AmuxRecommendationCapacity_wip_limit_check"
      CHECK ("wipLimit" IS NULL OR "wipLimit" BETWEEN 1 AND 10000)
);

CREATE TABLE "AmuxRecommendationSnapshot" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "scoringVersion" TEXT NOT NULL,
    "capacityConfigured" BOOLEAN NOT NULL,
    "capacityLimit" INTEGER,
    "capacityOccupied" INTEGER NOT NULL,
    "workerCapacity" TEXT NOT NULL,
    "classificationCapacity" TEXT NOT NULL,
    "itemBindingsDigest" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "includedCount" INTEGER NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "outcomeUnknownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationSnapshot_status_check"
      CHECK ("status" IN ('prepared', 'outcome_unknown')),
    CONSTRAINT "AmuxRecommendationSnapshot_worker_capacity_check"
      CHECK ("workerCapacity" IN ('closed')),
    CONSTRAINT "AmuxRecommendationSnapshot_classification_capacity_check"
      CHECK ("classificationCapacity" IN ('closed')),
    CONSTRAINT "AmuxRecommendationSnapshot_limit_check"
      CHECK ("capacityLimit" IS NULL OR "capacityLimit" BETWEEN 1 AND 10000)
);

CREATE UNIQUE INDEX "AmuxRecommendationSnapshot_authorizationAuditLogId_key"
  ON "AmuxRecommendationSnapshot"("authorizationAuditLogId");
CREATE INDEX "AmuxRecommendationSnapshot_status_expiresAt_idx"
  ON "AmuxRecommendationSnapshot"("status", "expiresAt");

CREATE TABLE "AmuxRecommendationSnapshotItem" (
    "snapshotId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "sourceDigest" TEXT,
    "executionBriefDigest" TEXT,
    "scoreTotal" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL,
    "exclusionCode" TEXT,

    CONSTRAINT "AmuxRecommendationSnapshotItem_pkey" PRIMARY KEY ("snapshotId", "workItemId"),
    CONSTRAINT "AmuxRecommendationSnapshotItem_disposition_check"
      CHECK ("disposition" IN ('included', 'excluded')),
    CONSTRAINT "AmuxRecommendationSnapshotItem_exclusion_code_check"
      CHECK (
        "exclusionCode" IS NULL OR
        "exclusionCode" IN (
          'not_backlog',
          'owner_set',
          'claimed',
          'archived',
          'lifecycle_present',
          'dependency_open',
          'source_unbound',
          'brief_digest_changed',
          'incident_blocked',
          'capacity_unconfigured',
          'capacity_full',
          'review_waiting'
        )
      ),
    CONSTRAINT "AmuxRecommendationSnapshotItem_disposition_pair_check"
      CHECK (
        ("disposition" = 'included' AND "exclusionCode" IS NULL) OR
        ("disposition" = 'excluded' AND "exclusionCode" IS NOT NULL)
      )
);

CREATE INDEX "AmuxRecommendationSnapshotItem_workItemId_idx"
  ON "AmuxRecommendationSnapshotItem"("workItemId");

CREATE TABLE "AmuxRecommendationDecision" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reviewAfter" TIMESTAMP(3),
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "outcomeUnknownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationDecision_decision_check"
      CHECK ("decision" IN ('approve', 'hold', 'reject', 'expired')),
    CONSTRAINT "AmuxRecommendationDecision_status_check"
      CHECK ("status" IN ('consumed', 'held', 'rejected', 'expired', 'outcome_unknown')),
    CONSTRAINT "AmuxRecommendationDecision_reason_code_check"
      CHECK (
        "reasonCode" IS NULL OR
        "reasonCode" IN ('capacity', 'dependency', 'cost', 'risk', 'scope', 'not_now')
      ),
    CONSTRAINT "AmuxRecommendationDecision_snapshotId_workItemId_key"
      UNIQUE ("snapshotId", "workItemId")
);

CREATE UNIQUE INDEX "AmuxRecommendationDecision_authorizationAuditLogId_key"
  ON "AmuxRecommendationDecision"("authorizationAuditLogId");

ALTER TABLE "AmuxRecommendationSnapshotItem"
  ADD CONSTRAINT "AmuxRecommendationSnapshotItem_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "AmuxRecommendationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AmuxRecommendationSnapshotItem_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmuxRecommendationDecision"
  ADD CONSTRAINT "AmuxRecommendationDecision_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "AmuxRecommendationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AmuxRecommendationDecision_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
