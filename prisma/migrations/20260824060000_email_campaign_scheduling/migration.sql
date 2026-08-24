-- Scheduling, and the model facts a retirement notice is about
-- (.github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3).
--
-- The second slice deliberately left these out: a column for an effective date
-- with nothing that schedules anything is half a feature, and a column that
-- lets a campaign name a date is a column that lets it promise something on
-- that date. Both halves arrive together.

ALTER TABLE "EmailCampaign"
    ADD COLUMN "triggerMode" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "scheduledAt" TIMESTAMP(3),
    ADD COLUMN "workItemId" TEXT,
    ADD COLUMN "targetModelId" TEXT,
    ADD COLUMN "replacementModelId" TEXT,
    ADD COLUMN "effectiveAt" TIMESTAMP(3),
    ADD COLUMN "timezoneLabel" TEXT,
    ADD COLUMN "audienceVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "estimatedRecipients" INTEGER,
    ADD COLUMN "claimsAutomaticTransition" BOOLEAN NOT NULL DEFAULT false;

-- The wave row exists before it runs, which is what makes scheduling possible:
-- a wave nobody has created cannot be found by a scheduler looking for due
-- work. NULL means an operator starts it by hand.
ALTER TABLE "EmailCampaignWave"
    ADD COLUMN "scheduledAt" TIMESTAMP(3);

ALTER TABLE "EmailCampaign"
    ADD CONSTRAINT "EmailCampaign_trigger_mode_check"
    CHECK ("triggerMode" IN ('manual', 'auto_draft', 'approved_schedule'));

-- Both or neither. A UTC instant with no timezone label is a date that reads
-- as a different day to the person receiving the notice than to the person who
-- set it -- and the sentence this pair exists for names a day.
ALTER TABLE "EmailCampaign"
    ADD CONSTRAINT "EmailCampaign_effective_at_has_a_timezone_check"
    CHECK (
        ("effectiveAt" IS NULL AND "timezoneLabel" IS NULL)
        OR ("effectiveAt" IS NOT NULL AND "timezoneLabel" IS NOT NULL)
    );

-- A promise about a model has to name the model, and the replacement it names
-- as the destination. Section 13.3's sentence cannot be written without both,
-- so a row that claims the transition without them is a row that cannot
-- produce the copy it says it will.
ALTER TABLE "EmailCampaign"
    ADD CONSTRAINT "EmailCampaign_transition_claim_names_models_check"
    CHECK (
        "claimsAutomaticTransition" = false
        OR ("targetModelId" IS NOT NULL AND "replacementModelId" IS NOT NULL)
    );

-- An audience estimate is a count, so it cannot be negative; a version numbers
-- the rules that produced it, so it starts at one.
ALTER TABLE "EmailCampaign"
    ADD CONSTRAINT "EmailCampaign_audience_estimate_check"
    CHECK (
        "audienceVersion" >= 1
        AND ("estimatedRecipients" IS NULL OR "estimatedRecipients" >= 0)
    );

-- The scheduler reads exactly this: waves that have not started, in time order.
CREATE INDEX "EmailCampaignWave_status_scheduledAt_idx"
    ON "EmailCampaignWave"("status", "scheduledAt");
