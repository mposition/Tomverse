-- One improvement cycle of the Auto LLM router's guidance
-- (lib/autoRouterOptimizerCore.ts): the proposal, the per-case verdicts, the
-- gate summary and what the cycle reserved and spent against the CHAT-01
-- optimizer caps and each provider's own budget (`providerReservations`,
-- settled when the cycle finishes; an interrupted cycle keeps its reservation).
--
-- No user content and no user link: evaluated decisions are named by
-- AutoRouterDecision id only, so deleting an account or conversation removes
-- the message text with the decision row and leaves an id that resolves to
-- nothing. Who started or promoted a cycle is recorded in AdminAuditLog.
--
-- baseline-check: present-if-relation "AutoRouterOptimizerCycle"

-- CreateTable
CREATE TABLE "AutoRouterOptimizerCycle" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "failure" TEXT,
    "optimizerModelId" TEXT NOT NULL,
    "routerModelId" TEXT NOT NULL,
    "incumbentGuidance" TEXT NOT NULL,
    "candidateGuidance" TEXT,
    "cases" JSONB,
    "summary" JSONB,
    "reservedMicroUsd" INTEGER NOT NULL,
    "providerReservations" JSONB,
    "startedBy" TEXT NOT NULL DEFAULT 'person',
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "promotedAt" TIMESTAMP(3),

    CONSTRAINT "AutoRouterOptimizerCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoRouterOptimizerCycle_createdAt_idx" ON "AutoRouterOptimizerCycle"("createdAt");

-- CreateIndex
CREATE INDEX "AutoRouterOptimizerCycle_status_idx" ON "AutoRouterOptimizerCycle"("status");
