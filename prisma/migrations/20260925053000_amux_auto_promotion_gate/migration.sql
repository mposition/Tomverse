-- Limited auto-promotion storage. This migration inserts no capacity row,
-- writes no card, and does not enable the auto-promotion latch.

CREATE TABLE "AmuxRecommendationAutoGrant" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationAutoGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationAutoGrant_status_check"
      CHECK ("status" IN ('active', 'consumed', 'expired'))
);

CREATE UNIQUE INDEX "AmuxRecommendationAutoGrant_authorizationAuditLogId_key"
  ON "AmuxRecommendationAutoGrant"("authorizationAuditLogId");
CREATE INDEX "AmuxRecommendationAutoGrant_workItemId_status_idx"
  ON "AmuxRecommendationAutoGrant"("workItemId", "status");

CREATE TABLE "AmuxRecommendationAutoConsumption" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "outcomeUnknownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationAutoConsumption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationAutoConsumption_status_check"
      CHECK ("status" IN ('consumed', 'outcome_unknown'))
);

CREATE UNIQUE INDEX "AmuxRecommendationAutoConsumption_grantId_key"
  ON "AmuxRecommendationAutoConsumption"("grantId");
CREATE UNIQUE INDEX "AmuxRecommendationAutoConsumption_authorizationAuditLogId_key"
  ON "AmuxRecommendationAutoConsumption"("authorizationAuditLogId");
CREATE INDEX "AmuxRecommendationAutoConsumption_workItemId_status_idx"
  ON "AmuxRecommendationAutoConsumption"("workItemId", "status");

CREATE TABLE "AmuxRecommendationAutoCostEntry" (
    "id" TEXT NOT NULL,
    "consumptionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxRecommendationAutoCostEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationAutoCostEntry_amount_check"
      CHECK ("amountCents" BETWEEN 0 AND 500)
);

CREATE UNIQUE INDEX "AmuxRecommendationAutoCostEntry_consumptionId_key"
  ON "AmuxRecommendationAutoCostEntry"("consumptionId");

CREATE TABLE "AmuxRecommendationAutoHalt" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "violationCode" TEXT,
    "actorUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxRecommendationAutoHalt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxRecommendationAutoHalt_reason_check"
      CHECK ("reason" IN ('critical_violation', 'outcome_unknown_burst')),
    CONSTRAINT "AmuxRecommendationAutoHalt_violation_code_check"
      CHECK (
        "violationCode" IS NULL OR
        "violationCode" IN (
          'cost_exceeded',
          'worker_cap_exceeded',
          'global_wip_exceeded',
          'unapproved_todo',
          'lifecycle_write'
        )
      )
);

CREATE UNIQUE INDEX "AmuxRecommendationAutoHalt_authorizationAuditLogId_key"
  ON "AmuxRecommendationAutoHalt"("authorizationAuditLogId");

ALTER TABLE "AmuxRecommendationAutoGrant"
  ADD CONSTRAINT "AmuxRecommendationAutoGrant_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmuxRecommendationAutoConsumption"
  ADD CONSTRAINT "AmuxRecommendationAutoConsumption_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "AmuxRecommendationAutoGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AmuxRecommendationAutoConsumption_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AmuxRecommendationAutoConsumption_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "AmuxRecommendationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmuxRecommendationAutoCostEntry"
  ADD CONSTRAINT "AmuxRecommendationAutoCostEntry_consumptionId_fkey"
  FOREIGN KEY ("consumptionId") REFERENCES "AmuxRecommendationAutoConsumption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
