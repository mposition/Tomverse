-- A failed slot carries no content, and now the database says so about the
-- commits too.
--
-- The original shape check (20261002150000) closed the failed branch for
-- `issueCount`, `payload` and `payloadDigest` and left `developSha` and
-- `mainSha` open. So a failed row could hold the commits of a successful
-- observation -- the exact "a failure showing an earlier success's content"
-- the constraint was written to prevent, through the two columns it forgot.
--
-- The route already refuses such a submission (`outcome_shape_invalid`, in
-- lib/productResearchObservationSubmission.ts) and the runner never builds
-- one. That is the application saying it; this is the database saying it, and
-- the point of the table's constraints is that they hold for a writer nobody
-- has reviewed.
--
-- Validated immediately rather than NOT VALID. A row that would violate this
-- cannot exist: the only writer is that route, which has refused these two
-- columns on a failed outcome since the table was created. There is no
-- backfill to wait for, so there is nothing for a deferred validation to be
-- deferred until.
-- Both statements in one transaction, as 20261002150000 does. Without it a
-- failed ADD after a successful DROP leaves the table with no shape check at
-- all, and the retry then fails on the DROP -- a migration that cannot be run
-- again and a table that is unconstrained until somebody repairs it by hand.
BEGIN;
ALTER TABLE "ProductResearchObservation"
    DROP CONSTRAINT "ProductResearchObservation_outcome_shape_check";

ALTER TABLE "ProductResearchObservation"
    ADD CONSTRAINT "ProductResearchObservation_outcome_shape_check"
        CHECK (
            ("outcome" = 'ok'
                AND "failureStage" IS NULL
                AND "developSha" IS NOT NULL
                AND "mainSha" IS NOT NULL
                AND "issueCount" IS NOT NULL
                AND "payload" IS NOT NULL
                AND "payloadDigest" IS NOT NULL)
            OR ("outcome" = 'failed'
                AND "failureStage" IS NOT NULL
                AND "developSha" IS NULL
                AND "mainSha" IS NULL
                AND "issueCount" IS NULL
                AND "payload" IS NULL
                AND "payloadDigest" IS NULL)
        );

COMMIT;
