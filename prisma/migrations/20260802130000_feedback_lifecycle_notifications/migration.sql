-- Submitter-facing lifecycle notifications for feedback reports.
--
-- Feedback gains a submission-time language snapshot, a per-report
-- transactional email consent, and the user-facing closure fields. The
-- consent default is false: existing rows never gain notifications they were
-- not asked about.
ALTER TABLE "Feedback" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Feedback" ADD COLUMN "emailUpdatesConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Feedback" ADD COLUMN "closureOutcome" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "userReply" TEXT;

-- One immutable row per lifecycle stage. The user email renders from this
-- snapshot, so a retried delivery cannot drift from the first attempt.
CREATE TABLE "FeedbackLifecycleEvent" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT NOT NULL,
    "outcomeCode" TEXT,
    "userReply" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- One event -- and therefore at most one user email -- per feedback and stage,
-- whatever the application layer does under concurrent requests.
CREATE UNIQUE INDEX "FeedbackLifecycleEvent_feedbackId_stage_key"
    ON "FeedbackLifecycleEvent"("feedbackId", "stage");
CREATE INDEX "FeedbackLifecycleEvent_feedbackId_createdAt_idx"
    ON "FeedbackLifecycleEvent"("feedbackId", "createdAt");

ALTER TABLE "FeedbackLifecycleEvent" ADD CONSTRAINT "FeedbackLifecycleEvent_feedbackId_fkey"
    FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
