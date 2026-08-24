-- The campaign's record of who was in the audience, including the people it
-- wrote nothing for (audit §12.2).
--
-- EmailDelivery records what was sent. Nothing records who was considered and
-- got nothing, because the reasons somebody is skipped are exactly the reasons
-- no delivery row is written for them -- so the cohort table in §13.2 ("-
-- excluded: suppressed 41") cannot be produced from any table that exists.

CREATE TABLE "EmailCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "waveId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailAddress" TEXT,
    "language" TEXT,
    "jurisdictionCountry" TEXT,
    "eligibilityReason" TEXT,
    "excludedReason" TEXT,
    "deliveryId" TEXT,
    "malformed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- One row per person per wave. This is the idempotency key: a resumed
-- expansion re-covering ground writes nothing twice, for the same reason
-- EmailDelivery's (eventId, recipientKey) index makes a resumed fan-out safe.
CREATE UNIQUE INDEX "EmailCampaignRecipient_waveId_userId_key"
    ON "EmailCampaignRecipient"("waveId", "userId");

-- A delivery row belongs to exactly one ledger entry, so the two can be
-- reconciled without matching on address.
CREATE UNIQUE INDEX "EmailCampaignRecipient_deliveryId_key"
    ON "EmailCampaignRecipient"("deliveryId");

-- The question this table is built to answer: how many of this campaign were
-- excluded, and for what.
CREATE INDEX "EmailCampaignRecipient_campaignId_excludedReason_idx"
    ON "EmailCampaignRecipient"("campaignId", "excludedReason");

ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_waveId_fkey"
    FOREIGN KEY ("waveId") REFERENCES "EmailCampaignWave"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The three cohorts of §13.1 that this repository can actually compute.
-- `recent_usage` is in the audit's list and is deliberately absent: §13.1 marks
-- it "가능하나 비용 큼" and nothing computes it, so allowing the value would let
-- a row claim a cohort no code produces.
ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_eligibility_reason_check"
    CHECK ("eligibilityReason" IS NULL OR "eligibilityReason" IN (
        'default_model',
        'new_conversation_lead',
        'conversation_selection'
    ));

-- `malformed` is not in this list. An unreadable stored value means the account
-- cannot be migrated automatically, not that it should be left uninformed --
-- summariseAudience() counts malformed accounts inside the notice audience and
-- outside autoMigratable, and an exclusion reason here would contradict the
-- calculator that both the reminder and the migration read.
ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_excluded_reason_check"
    CHECK ("excludedReason" IS NULL OR "excludedReason" IN (
        'no_email',
        'account_inactive',
        'suppressed',
        'no_consent',
        'plan_incompatible',
        'already_changed'
    ));

-- An included person has a cohort and no exclusion; an excluded one has a
-- reason and no delivery. Without this a row can say both at once, and the
-- excluded counts and the sent counts would each be right on their own while
-- summing to more than the audience.
ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_outcome_is_one_or_the_other_check"
    CHECK (
        ("excludedReason" IS NULL AND "eligibilityReason" IS NOT NULL)
        OR ("excludedReason" IS NOT NULL AND "deliveryId" IS NULL)
    );

-- The one exclusion that is allowed to have no cohort, because it *is* the
-- absence of one. Every other reason describes somebody still affected.
ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_only_already_changed_has_no_cohort_check"
    CHECK (
        "eligibilityReason" IS NOT NULL
        OR "excludedReason" = 'already_changed'
    );

-- Cascaded, unlike EmailDelivery's SetNull. A delivery row is evidence that a
-- required notice was delivered and outlives the account for that reason; this
-- row is the record that one was *not*, which nothing obliges anybody to keep
-- -- and it holds the address, so keeping it unlinked would be the worse of the
-- two outcomes rather than the safer one.
ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
