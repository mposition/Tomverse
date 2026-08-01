-- STG-R002: verified provider recovery.
--
-- Background: Perplexity's deep-research model rejected five requests with
-- HTTP 400 invalid_message. Those rejections were counted as provider
-- failures, so ProviderHealthState.consecutiveFailures reached 5 with
-- lastSuccessAt still NULL, which pinned the whole provider -- and every model
-- under it -- to Incident/unavailable. consecutiveFailures only resets on a
-- recorded success, and no success could be recorded while every model was
-- reported unavailable: a self-locking state with no exit.
--
-- The exit is an administrator-triggered live verification call whose success
-- authorises clearing the counter. The columns below record that evidence.
-- Synthetic verification is deliberately kept out of lastSuccessAt: an
-- operator proving the API answers is not the same claim as "real user
-- traffic is being served".

-- AlterTable: administrator verification evidence and recovery bookkeeping.
ALTER TABLE "ProviderHealthState"
  ADD COLUMN "lastVerificationSuccessAt" TIMESTAMP(3),
  ADD COLUMN "lastVerificationFailureAt" TIMESTAMP(3),
  ADD COLUMN "lastRecoveryAt" TIMESTAMP(3),
  ADD COLUMN "lastRecoveryCheckId" TEXT;

-- AlterTable: ProviderHealthCheck becomes the verification attempt log as
-- well as the configuration readiness log. Existing rows are configuration
-- checks, which is what the default backfills them as.
ALTER TABLE "ProviderHealthCheck"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'configuration',
  ADD COLUMN "diagnosticCode" TEXT,
  ADD COLUMN "traceId" TEXT,
  ADD COLUMN "recoveryApplied" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recoveryAppliedAt" TIMESTAMP(3),
  ADD COLUMN "previousConsecutiveFailures" INTEGER;

-- CreateIndex: the verification flow reads "the most recent live verification
-- for this provider" on every cooldown check and every recovery attempt.
CREATE INDEX "ProviderHealthCheck_provider_kind_createdAt_idx"
  ON "ProviderHealthCheck"("provider", "kind", "createdAt");
