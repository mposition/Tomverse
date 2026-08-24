-- The three conditions of section 13.3 that no field holds
-- (.github/audits/model-lifecycle-email-2026-08-22.md §13.3).
--
-- The fourth slice named them and left them unstored. An attestation with
-- nowhere to live is a parameter a caller could pass `true` for; what makes it
-- worth anything is who said it and when, so those are columns.

CREATE TABLE "EmailCampaignAttestation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attestedByEmail" TEXT NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "contentDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailCampaignAttestation_pkey" PRIMARY KEY ("id")
);

-- One standing statement per kind. Re-attesting replaces it rather than
-- stacking, so "who says this is true" has one answer.
CREATE UNIQUE INDEX "EmailCampaignAttestation_campaignId_kind_key"
    ON "EmailCampaignAttestation"("campaignId", "kind");

ALTER TABLE "EmailCampaignAttestation"
    ADD CONSTRAINT "EmailCampaignAttestation_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailCampaignAttestation"
    ADD CONSTRAINT "EmailCampaignAttestation_kind_check"
    CHECK ("kind" IN (
        'differences_stated',
        'staging_verified',
        'reconciliation_ready'
    ));

-- An attestation names a person. An empty string is not a name, and it is what
-- a form posts when the field was never filled.
ALTER TABLE "EmailCampaignAttestation"
    ADD CONSTRAINT "EmailCampaignAttestation_attested_by_check"
    CHECK (length(btrim("attestedByEmail")) > 0);

-- `differences_stated` is a claim about the words, so it carries the digest the
-- words had. The other two are about the migration -- a rehearsal and a
-- rollback -- which a copy edit does not undo, and giving them a digest would
-- expire them for a reason that has nothing to do with what they assert.
ALTER TABLE "EmailCampaignAttestation"
    ADD CONSTRAINT "EmailCampaignAttestation_digest_only_for_content_check"
    CHECK (
        ("kind" = 'differences_stated' AND "contentDigest" IS NOT NULL)
        OR ("kind" <> 'differences_stated' AND "contentDigest" IS NULL)
    );
