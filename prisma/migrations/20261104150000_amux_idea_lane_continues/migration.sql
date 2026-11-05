-- An idea lane run that did one part of a larger idea (its implement time is
-- bounded) and named the remaining work in its draft PR. Once that PR merges,
-- the claim (lib/amux/ideaLaneService.ts) takes the idea again for the next
-- part, so a later part never starts before the earlier one is on develop.
-- Only an opened PR can carry it.

-- AlterTable
ALTER TABLE "AmuxIdeaLaneAttempt" ADD COLUMN "continues" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_continues_check"
    CHECK (NOT "continues" OR "outcome" IS NOT DISTINCT FROM 'pr_open');
