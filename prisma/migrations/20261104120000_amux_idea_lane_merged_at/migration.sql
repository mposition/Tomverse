-- The idea lane's draft PR merged into develop (lib/engineeringAgentPrObserver.ts
-- records it from GitHub, once): the idea is then done on the Ideas list. Only
-- an opened PR can merge, and the time is GitHub's own merge time.

-- AlterTable
ALTER TABLE "AmuxIdeaLaneAttempt" ADD COLUMN "mergedAt" TIMESTAMP(3);

ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_merged_check"
    CHECK ("mergedAt" IS NULL OR "outcome" = 'pr_open');
