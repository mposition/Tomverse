-- How the idea lane's draft PR stands on GitHub: merged (the idea is then
-- done on the Ideas list) or closed without a merge (the owner looks at it; a
-- reopened PR goes back to review). observeAmuxIdeaLaneMerges
-- (lib/amux/ideaLaneService.ts) reads the PRs in the engineering agent's PR
-- observer round, least recently read first, and stamps each read. Only an
-- opened PR carries these, and a merged one is never closed as well.

-- AlterTable
ALTER TABLE "AmuxIdeaLaneAttempt" ADD COLUMN "mergedAt" TIMESTAMP(3),
    ADD COLUMN "prClosedAt" TIMESTAMP(3),
    ADD COLUMN "prObservedAt" TIMESTAMP(3);

ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_pr_end_check"
    CHECK (("mergedAt" IS NULL AND "prClosedAt" IS NULL AND "prObservedAt" IS NULL)
      -- IS NOT DISTINCT FROM: a run still going (outcome NULL) must not pass as unknown.
      OR ("outcome" IS NOT DISTINCT FROM 'pr_open' AND ("mergedAt" IS NULL OR "prClosedAt" IS NULL)));
