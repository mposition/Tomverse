-- An audience estimate that was measured, and says when and by whom.
--
-- Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.3.
--
-- `estimatedRecipients` and `audienceVersion` have existed since the fourth
-- slice. Nothing ever wrote either from the audience: the number arrived by an
-- operator typing it into a PATCH, and the version stayed at its default
-- forever, so a column whose stated job is "which rules produced this estimate"
-- answered "version 1" for estimates no rules had produced.
--
-- These three columns are what turn the number into a measurement. Without the
-- timestamp a stored count is of unknown age against an audience that moves
-- daily; without the summary the exclusion breakdown -- the part that says the
-- audience query is wrong -- exists only in the response of the request that
-- computed it, so the second administrator reviewing the campaign never sees it.

ALTER TABLE "EmailCampaign"
    ADD COLUMN "estimatedAt" TIMESTAMP(3),
    ADD COLUMN "estimatedByEmail" TEXT,
    -- The full AudienceSummary. Denormalising its headline into
    -- `estimatedRecipients` is deliberate: that column already exists, the list
    -- view already reads it, and the two are written in one statement so they
    -- cannot drift apart within a write.
    ADD COLUMN "audienceEstimate" JSONB;

-- An estimate is a number, a time and a summary together, or it is none of them.
--
-- NOT VALID: rows written before this migration may hold a typed
-- `estimatedRecipients` with no timestamp, and those are exactly the estimates
-- this constraint exists to stop being taken for measurements. They are left in
-- place to be re-measured rather than deleted, and validating is a separate
-- migration once none remain.
ALTER TABLE "EmailCampaign"
    ADD CONSTRAINT "EmailCampaign_audience_estimate_complete_check"
    CHECK (
        (
            "estimatedRecipients" IS NULL
            AND "estimatedAt" IS NULL
            AND "audienceEstimate" IS NULL
        )
        OR (
            "estimatedRecipients" IS NOT NULL
            AND "estimatedAt" IS NOT NULL
            AND "audienceEstimate" IS NOT NULL
        )
    ) NOT VALID;
