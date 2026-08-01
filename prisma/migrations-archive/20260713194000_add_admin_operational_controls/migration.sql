CREATE TABLE "AdminActionApproval" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "payload" JSONB,
    "requestedById" TEXT,
    "requestedByEmail" TEXT,
    "reviewedById" TEXT,
    "reviewedByEmail" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminActionApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminActionApproval_status_createdAt_idx" ON "AdminActionApproval"("status", "createdAt");
CREATE INDEX "AdminActionApproval_action_createdAt_idx" ON "AdminActionApproval"("action", "createdAt");
CREATE INDEX "AdminActionApproval_targetType_targetId_idx" ON "AdminActionApproval"("targetType", "targetId");

CREATE TABLE "AdminAlertPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "budgetThresholds" TEXT NOT NULL DEFAULT '[50,80,95]',
    "providerFailureThreshold" INTEGER NOT NULL DEFAULT 5,
    "modelFailureThreshold" INTEGER NOT NULL DEFAULT 3,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifySlack" BOOLEAN NOT NULL DEFAULT false,
    "notifyDiscord" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminAlertPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAlertPolicy_isActive_idx" ON "AdminAlertPolicy"("isActive");
CREATE INDEX "AdminAlertPolicy_provider_idx" ON "AdminAlertPolicy"("provider");
