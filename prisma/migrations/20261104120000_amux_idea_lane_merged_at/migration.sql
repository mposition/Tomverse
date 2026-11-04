-- How the idea lane's draft PR ended, as GitHub reports it: merged (the idea
-- is then done on the Ideas list) or closed without a merge (the owner looks
-- at it). observeAmuxIdeaLaneMerges (lib/amux/ideaLaneService.ts) records it
-- once, in the engineering agent's PR observer round. Only an opened PR can
-- end, and it ends one way.

-- AlterTable
ALTER TABLE "AmuxIdeaLaneAttempt" ADD COLUMN "mergedAt" TIMESTAMP(3),
    ADD COLUMN "prClosedAt" TIMESTAMP(3);

ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_pr_end_check"
    CHECK (("mergedAt" IS NULL AND "prClosedAt" IS NULL)
      OR ("outcome" = 'pr_open' AND ("mergedAt" IS NULL OR "prClosedAt" IS NULL)));
