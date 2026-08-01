-- CreateTable
CREATE TABLE "ChatLimitDecisionEvent" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "userId" TEXT,
    "plan" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "errorCode" TEXT,
    "limitLayer" TEXT,
    "limitScope" TEXT,
    "modelIds" TEXT[],
    "enabledTools" TEXT[],
    "estimatedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "pricingVersions" TEXT[],
    "models" JSONB NOT NULL,
    "requiredCredits" INTEGER,
    "availableCredits" INTEGER,
    "usedAllowanceMicroUsd" BIGINT,
    "requiredAllowanceMicroUsd" BIGINT,
    "limitMicroUsd" BIGINT,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "resetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLimitDecisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_traceId_idx" ON "ChatLimitDecisionEvent"("traceId");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_createdAt_idx" ON "ChatLimitDecisionEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_userId_createdAt_idx" ON "ChatLimitDecisionEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatLimitDecisionEvent_subjectKey_createdAt_idx" ON "ChatLimitDecisionEvent"("subjectKey", "createdAt");
