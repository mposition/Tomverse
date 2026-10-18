-- A promotion prepares an inert rollout binding in the same transaction.
-- No row created here can authorize product routing or start a canary clock.
CREATE TABLE "ChatUnifiedOptimizerCanaryRollout" (
  "promotionReceiptId" UUID NOT NULL PRIMARY KEY,
  "productKey" TEXT NOT NULL,
  "pointerRevision" INTEGER NOT NULL,
  "cycleId" UUID NOT NULL,
  "candidateId" UUID NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "bundleDigest" TEXT NOT NULL,
  "assignmentSalt" UUID NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'prepared',
  "phaseRevision" INTEGER NOT NULL DEFAULT 0,
  "canaryStartedAt" TIMESTAMPTZ(3),
  "phaseStartedAt" TIMESTAMPTZ(3),
  "activationAuditLogId" TEXT,
  "lastAuditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "pointerRevision" > 0
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND "bundleDigest" ~ '^[0-9a-f]{64}$'
    AND "phaseRevision" >= 0
    AND "phase" IN ('prepared', 'candidate_5', 'candidate_25',
      'candidate_90', 'active_100')
    AND (("phase" = 'prepared' AND "phaseRevision" = 0
      AND "canaryStartedAt" IS NULL AND "phaseStartedAt" IS NULL
      AND "activationAuditLogId" IS NULL)
      OR ("phase" <> 'prepared' AND "phaseRevision" > 0
      AND "canaryStartedAt" IS NOT NULL
      AND "phaseStartedAt" IS NOT NULL
      AND "phaseStartedAt" >= "canaryStartedAt"
      AND "activationAuditLogId" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "ChatUnifiedOptimizerCanaryRollout_productKey_pointerRevision_key"
  ON "ChatUnifiedOptimizerCanaryRollout"("productKey", "pointerRevision");
CREATE INDEX "ChatUnifiedOptimizerCanaryRollout_candidateId_createdAt_idx"
  ON "ChatUnifiedOptimizerCanaryRollout"("candidateId", "createdAt");

ALTER TABLE "ChatUnifiedOptimizerCanaryRollout"
  ADD CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_promotionReceiptId_fkey"
    FOREIGN KEY ("promotionReceiptId") REFERENCES
      "ChatUnifiedOptimizerPromotionReceipt"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES
      "ChatUnifiedOptimizerCandidate"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_lastAuditLogId_fkey"
    FOREIGN KEY ("lastAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_activationAuditLogId_fkey"
    FOREIGN KEY ("activationAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
