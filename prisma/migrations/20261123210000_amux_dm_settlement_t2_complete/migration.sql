-- Owner decision 2026-11-23 (conversation, from AMUX-CRAWL-003): the Decision
-- Maker may settle a review pull request's Task as done, its work already in.
-- Until now a review pull request could only be approved, run again or have
-- its card closed, so a T2 card whose work was already on develop was run
-- again and again, each run opening one more draft pull request. Nothing else
-- in the state CHECK changes. No row changes.
--
-- Rollback: drop and add the constraint again without 'complete' for t2_pr
-- (only possible while no applied t2_pr settlement holds it).
BEGIN;

ALTER TABLE "AmuxDmOwnerSettlement"
    DROP CONSTRAINT "AmuxDmOwnerSettlement_state_check",
    ADD CONSTRAINT "AmuxDmOwnerSettlement_state_check" CHECK (
        ("state" = 'open' AND "decision" IS NULL AND "answerSource" IS NULL AND
          "decidedAt" IS NULL AND "cancelReason" IS NULL AND
          "approvedHeadSha" IS NULL AND "remakeIdeaId" IS NULL) OR
        ("state" = 'claimed' AND "kind" = 'stopped' AND "decision" = 'remake' AND
          "answerSource" IS NOT NULL AND "requestId" IS NOT NULL AND "decidedAt" IS NOT NULL AND
          "cancelReason" IS NULL AND "approvedHeadSha" IS NULL) OR
        ("state" = 'applied' AND "answerSource" IS NOT NULL AND "requestId" IS NOT NULL AND
          "decidedAt" IS NOT NULL AND "cancelReason" IS NULL AND "handoffAt" IS NULL AND
          (("kind" = 'stopped' AND "decision" IN ('retry', 'complete', 'close', 'remake')) OR
           ("kind" = 't2_pr' AND "decision" IN ('approve', 'retry', 'complete', 'close'))) AND
          (("decision" = 'approve') = ("approvedHeadSha" IS NOT NULL)) AND
          (("decision" = 'remake') = ("remakeIdeaId" IS NOT NULL))) OR
        ("state" = 'cancelled' AND ("decision" IS NULL OR "decision" = 'remake') AND
          "cancelReason" IS NOT NULL AND "approvedHeadSha" IS NULL)
    );

COMMIT;
