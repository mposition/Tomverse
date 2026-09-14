-- Campaign-authored copy and the consent cohort for product announcements.
--
-- `contentByLocale` has no default. Existing campaigns predate authored
-- content, and pretending they approved a generated value would turn missing
-- evidence into an approval. Application code refuses those legacy rows until
-- they are redrafted.
ALTER TABLE "EmailCampaign"
    ADD COLUMN "contentByLocale" JSONB;

-- Product announcements record why a person was considered just like model
-- lifecycle campaigns do. Replace the closed CHECK rather than weakening it
-- to arbitrary text, so reports cannot acquire invented cohort names.
ALTER TABLE "EmailCampaignRecipient"
    DROP CONSTRAINT "EmailCampaignRecipient_eligibility_reason_check";

ALTER TABLE "EmailCampaignRecipient"
    ADD CONSTRAINT "EmailCampaignRecipient_eligibility_reason_check"
    CHECK ("eligibilityReason" IS NULL OR "eligibilityReason" IN (
        'default_model',
        'new_conversation_lead',
        'conversation_selection',
        'marketing_consent'
    ));
