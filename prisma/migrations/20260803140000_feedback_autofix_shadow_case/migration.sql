-- Phase 2 of the trace feedback automation rollout: diagnosis-only shadow
-- cases. One case per verified bug report; the worker only collects evidence
-- and classifies -- no code mutation, no branches, no PRs.
CREATE TABLE "FeedbackAutoFixCase" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "fingerprint" TEXT,
    "sourceRelease" TEXT,
    "state" TEXT NOT NULL DEFAULT 'received',
    "classification" TEXT,
    "ineligibilityReason" TEXT,
    "llmConfidence" DOUBLE PRECISION,
    "diagnosticSummary" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "terminalReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackAutoFixCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedbackAutoFixCase_feedbackId_key" ON "FeedbackAutoFixCase"("feedbackId");
CREATE INDEX "FeedbackAutoFixCase_state_leaseExpiresAt_idx" ON "FeedbackAutoFixCase"("state", "leaseExpiresAt");
CREATE INDEX "FeedbackAutoFixCase_createdAt_idx" ON "FeedbackAutoFixCase"("createdAt");
CREATE INDEX "FeedbackAutoFixCase_fingerprint_sourceRelease_idx" ON "FeedbackAutoFixCase"("fingerprint", "sourceRelease");

ALTER TABLE "FeedbackAutoFixCase" ADD CONSTRAINT "FeedbackAutoFixCase_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
