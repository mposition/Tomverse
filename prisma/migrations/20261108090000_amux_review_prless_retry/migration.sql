-- An owner may run a v22 Task again from review when its result reached
-- review without a pull request (owner decision 2026-11-08, AMUX-FILEGEN-003):
-- an implement Task whose patch stayed private, or that left no change, can
-- not be approved without a pull request, so block was its only choice. The
-- app offers this retry only for that case and under the same attempt budget
-- (lib/amux/reviewApproval.ts); the issue guard still checks the budget, the
-- delivery fence and that the review attempt succeeded into review.
--
-- Additive: every transition the previous check allowed is still allowed, so
-- no existing row can fail the validation. No row is read or written. One
-- ALTER TABLE holding the DROP and the ADD, so the constraint is never absent
-- and baseline-check.json can bind the replacement
-- (scripts/baseline-presence-core.mjs).
ALTER TABLE "AmuxReviewProposal"
    DROP CONSTRAINT "AmuxReviewProposal_transition_check",
    ADD CONSTRAINT "AmuxReviewProposal_transition_check"
        CHECK (
            ("sourceStatus" = 'review' AND "outcome" = 'approve' AND "targetStatus" = 'done')
            OR ("sourceStatus" = 'review' AND "outcome" = 'block' AND "targetStatus" = 'blocked')
            OR ("sourceStatus" = 'review' AND "outcome" = 'retry' AND "targetStatus" = 'todo')
            OR ("sourceStatus" = 'blocked' AND "outcome" = 'retry' AND "targetStatus" = 'todo')
            OR ("sourceStatus" = 'blocked' AND "outcome" = 'block' AND "targetStatus" = 'blocked')
        );
