-- Email notification system, MVP data model.
--
-- Contract: .github/audits/email-notification-architecture-2026-08-21.md
--
-- Every table here is new and every column added to an existing table is
-- nullable, so this migration is additive and has no backfill. What it is not
-- is neutral: the CHECK constraints at the bottom are where the decisions in
-- the contract stop being conventions that a future change can quietly invert.
--
-- Three of them are worth naming up front, because they are the ones that will
-- look like obstacles later:
--
--  - EmailTemplate_unsubscribe_check ties the unsubscribe link to the
--    classification. A marketing template without one, or a transactional
--    template with one, cannot be stored. The second half matters as much as
--    the first: an unsubscribe link on a login code is a button that locks
--    people out of their own account.
--  - EmailPreference_locked_check keeps security and billing preferences
--    enabled. An attacker who can turn off security mail turns off the warning
--    about themselves.
--  - EmailDelivery_credential_no_snapshot_check keeps the credential lane from
--    storing what it renders. The personalisation inputs of a login code *are*
--    the login code, so the column that exists to make other mail reproducible
--    has to stay empty here.
-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "country" TEXT,
ADD COLUMN     "countrySource" TEXT,
ADD COLUMN     "countryUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailPolicyVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "changeSummary" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedByEmail" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JurisdictionProfile" (
    "id" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "marketingBasis" TEXT NOT NULL,
    "subjectPrefix" TEXT,
    "footerBlocks" JSONB NOT NULL,
    "unsubscribeSlaBusinessDays" INTEGER NOT NULL,
    "consentNoticeIntervalMonths" INTEGER,
    "quietHours" JSONB,
    "impliedConsentDays" JSONB,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JurisdictionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JurisdictionCountryMap" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JurisdictionCountryMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "purpose" TEXT,
    "requiresUnsubscribe" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "lastConfirmationNoticeAt" TIMESTAMP(3),
    "nextConfirmationNoticeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailAddress" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jurisdiction" TEXT NOT NULL,
    "jurisdictionSource" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "capturedVia" TEXT NOT NULL,
    "evidence" JSONB,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "purposeKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceStream" TEXT,
    "sourceDomain" TEXT,
    "sourceClassification" TEXT,
    "sourceDeliveryId" TEXT,
    "sourceMessageId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "payload" JSONB NOT NULL,
    "audienceKind" TEXT NOT NULL,
    "audienceSpec" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expansionCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT,
    "recipientKey" TEXT NOT NULL,
    "lane" TEXT NOT NULL DEFAULT 'standard',
    "emailAddress" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "jurisdictionCountry" TEXT NOT NULL,
    "jurisdictionProfileKey" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorKind" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "providerMessageId" TEXT,
    "renderedSubject" TEXT,
    "renderedHash" TEXT,
    "renderedHashKeyVersion" TEXT,
    "renderDataSnapshot" JSONB,
    "snapshotPurgedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "processingError" TEXT,

    CONSTRAINT "ProviderWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailPolicyVersion_version_key" ON "EmailPolicyVersion"("version");

-- CreateIndex
CREATE INDEX "EmailPolicyVersion_status_activatedAt_idx" ON "EmailPolicyVersion"("status", "activatedAt");

-- CreateIndex
CREATE INDEX "JurisdictionProfile_policyVersionId_idx" ON "JurisdictionProfile"("policyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "JurisdictionProfile_profileKey_policyVersionId_key" ON "JurisdictionProfile"("profileKey", "policyVersionId");

-- CreateIndex
CREATE INDEX "JurisdictionCountryMap_policyVersionId_profileKey_idx" ON "JurisdictionCountryMap"("policyVersionId", "profileKey");

-- CreateIndex
CREATE UNIQUE INDEX "JurisdictionCountryMap_countryCode_policyVersionId_key" ON "JurisdictionCountryMap"("countryCode", "policyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_key_key" ON "EmailTemplate"("key");

-- CreateIndex
CREATE INDEX "EmailTemplate_classification_idx" ON "EmailTemplate"("classification");

-- CreateIndex
CREATE INDEX "TemplateVersion_templateId_status_language_idx" ON "TemplateVersion"("templateId", "status", "language");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_language_key" ON "TemplateVersion"("templateId", "version", "language");

-- CreateIndex
CREATE INDEX "EmailPreference_nextConfirmationNoticeAt_idx" ON "EmailPreference"("nextConfirmationNoticeAt");

-- CreateIndex
CREATE INDEX "EmailPreference_purpose_enabled_idx" ON "EmailPreference"("purpose", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EmailPreference_userId_purpose_key" ON "EmailPreference"("userId", "purpose");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_purpose_occurredAt_idx" ON "ConsentRecord"("userId", "purpose", "occurredAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_emailAddress_occurredAt_idx" ON "ConsentRecord"("emailAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_policyVersionId_idx" ON "ConsentRecord"("policyVersionId");

-- CreateIndex
CREATE INDEX "SuppressionEntry_emailAddress_idx" ON "SuppressionEntry"("emailAddress");

-- CreateIndex
CREATE INDEX "SuppressionEntry_reason_sourceStream_occurredAt_idx" ON "SuppressionEntry"("reason", "sourceStream", "occurredAt");

-- CreateIndex
CREATE INDEX "SuppressionEntry_expiresAt_idx" ON "SuppressionEntry"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_emailAddress_scope_purposeKey_key" ON "SuppressionEntry"("emailAddress", "scope", "purposeKey");

-- CreateIndex
CREATE INDEX "EmailEvent_status_createdAt_idx" ON "EmailEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailEvent_templateId_createdAt_idx" ON "EmailEvent"("templateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_idempotencyKey_key" ON "EmailDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_lane_nextAttemptAt_idx" ON "EmailDelivery"("status", "lane", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_eventId_status_idx" ON "EmailDelivery"("eventId", "status");

-- CreateIndex
CREATE INDEX "EmailDelivery_userId_createdAt_idx" ON "EmailDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_emailAddress_createdAt_idx" ON "EmailDelivery"("emailAddress", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_snapshotPurgedAt_idx" ON "EmailDelivery"("status", "snapshotPurgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_eventId_recipientKey_key" ON "EmailDelivery"("eventId", "recipientKey");

-- CreateIndex
CREATE INDEX "ProviderWebhookEvent_provider_eventType_receivedAt_idx" ON "ProviderWebhookEvent"("provider", "eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "ProviderWebhookEvent_processedAt_idx" ON "ProviderWebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderWebhookEvent_provider_providerEventId_key" ON "ProviderWebhookEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "JurisdictionProfile" ADD CONSTRAINT "JurisdictionProfile_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JurisdictionCountryMap" ADD CONSTRAINT "JurisdictionCountryMap_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EmailEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma's schema language cannot express.
--
-- schema.prisma has no CHECK and no partial index, so everything below is
-- invisible to `prisma migrate diff` -- it will neither create these nor
-- notice if they drift. `npm run db:compare-schema` is what sees them.
-- ---------------------------------------------------------------------------

-- Exactly one policy version may be active. Without this, two racing
-- activations both succeed and deliveries afterwards resolve against whichever
-- one their query happened to read.
CREATE UNIQUE INDEX "EmailPolicyVersion_active_key"
    ON "EmailPolicyVersion" ("status")
    WHERE "status" = 'active';

ALTER TABLE "EmailPolicyVersion" ADD CONSTRAINT "EmailPolicyVersion_status_check"
    CHECK ("status" IN ('draft', 'active', 'superseded'));

-- Recorded as the jurisdiction states it, even though C1 sends opt-in
-- everywhere. A profile that reports our policy instead of the law is no use
-- as evidence about the law.
ALTER TABLE "JurisdictionProfile" ADD CONSTRAINT "JurisdictionProfile_marketing_basis_check"
    CHECK ("marketingBasis" IN ('opt_in', 'opt_out'));

-- A notice interval of zero or a negative one would schedule the confirmation
-- duty into the past forever.
ALTER TABLE "JurisdictionProfile" ADD CONSTRAINT "JurisdictionProfile_notice_interval_check"
    CHECK ("consentNoticeIntervalMonths" IS NULL OR "consentNoticeIntervalMonths" > 0);

ALTER TABLE "JurisdictionProfile" ADD CONSTRAINT "JurisdictionProfile_unsubscribe_sla_check"
    CHECK ("unsubscribeSlaBusinessDays" > 0);

ALTER TABLE "JurisdictionCountryMap" ADD CONSTRAINT "JurisdictionCountryMap_country_check"
    CHECK ("countryCode" ~ '^[A-Z]{2}$');

ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_classification_check"
    CHECK ("classification" IN ('transactional', 'service', 'legal', 'marketing'));

-- The classification decides the unsubscribe link, in both directions.
-- `service` is left free because it spans two cases: a maintenance notice is
-- opt-outable, a breach notification is not.
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_unsubscribe_check"
    CHECK (
        ("classification" = 'marketing' AND "requiresUnsubscribe")
        OR ("classification" IN ('transactional', 'legal') AND NOT "requiresUnsubscribe")
        OR "classification" = 'service'
    );

-- Anything gated by a preference must name the preference; anything not
-- gateable must not pretend to be.
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_purpose_check"
    CHECK (
        ("classification" IN ('marketing', 'service') AND "purpose" IS NOT NULL)
        OR ("classification" IN ('transactional', 'legal') AND "purpose" IS NULL)
    );

ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_status_check"
    CHECK ("status" IN ('draft', 'published', 'retired'));

-- A published version has to say when, or "which version was live that day"
-- has no answer.
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_published_at_check"
    CHECK ("status" <> 'published' OR "publishedAt" IS NOT NULL);

ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_version_check"
    CHECK ("version" > 0);

ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_purpose_check"
    CHECK ("purpose" IN (
        'security', 'billing', 'service_status',
        'product_updates', 'newsletter', 'promotions'
    ));

-- Security and billing mail cannot be switched off -- not by the preference
-- centre, not by an unsubscribe link, and not by a mistaken admin write.
-- Stated here rather than only in the service layer because there is no
-- version of "the user asked to stop receiving login alerts" that we act on.
ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_locked_check"
    CHECK ("purpose" NOT IN ('security', 'billing') OR "enabled");

ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_source_check"
    CHECK ("source" IN (
        'signup', 'preference_center', 'unsubscribe_link', 'admin', 'system_default'
    ));

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_action_check"
    CHECK ("action" IN (
        'granted', 'withdrawn', 'reconfirmed', 'confirmation_notice_sent', 'lapsed'
    ));

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_captured_via_check"
    CHECK ("capturedVia" IN (
        'signup_form', 'preference_center', 'unsubscribe_page', 'import', 'admin'
    ));

ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_scope_check"
    CHECK ("scope" IN ('global', 'purpose'));

-- purposeKey carries the scope rather than being NULL for global entries.
-- PostgreSQL treats NULLs as distinct, so a nullable column in the unique key
-- would let one address accumulate unlimited global suppressions -- and a
-- suppression list that can hold duplicates is one whose lookups disagree.
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_purpose_key_check"
    CHECK (
        ("scope" = 'global' AND "purposeKey" = '*')
        OR ("scope" = 'purpose' AND "purposeKey" <> '*')
    );

ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_reason_check"
    CHECK ("reason" IN (
        'hard_bounce', 'soft_bounce', 'complaint',
        'unsubscribe', 'manual', 'privacy_request'
    ));

-- Only a soft bounce is temporary. An expiry on a complaint would schedule the
-- day we start mailing someone who reported us as spam.
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_expiry_check"
    CHECK ("expiresAt" IS NULL OR "reason" = 'soft_bounce');

ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_source_stream_check"
    CHECK ("sourceStream" IS NULL OR "sourceStream" IN ('transactional', 'marketing'));

ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_status_check"
    CHECK ("status" IN ('pending', 'expanding', 'expanded', 'failed'));

ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_audience_kind_check"
    CHECK ("audienceKind" IN ('single_user', 'user_segment', 'all_users'));

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_lane_check"
    CHECK ("lane" IN ('credential_sync', 'standard'));

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_status_check"
    CHECK ("status" IN (
        'pending', 'sent', 'delivered', 'bounced', 'complained',
        'suppressed', 'skipped', 'failed', 'abandoned'
    ));

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'credential_expired', 'dry_run'
    ));

-- recipientKey is the fan-out identity, so a malformed one is a duplicate
-- waiting to happen rather than a cosmetic problem.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_recipient_key_check"
    CHECK ("recipientKey" ~ '^(user|addr):.+');

-- The credential lane stores no credential. renderDataSnapshot exists so other
-- mail can be reconstructed for an audit; for a login code the inputs are the
-- secret itself, so minimising them leaves nothing to store. Written as a
-- constraint because "we agreed not to populate it" survives exactly as long as
-- whoever agreed.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_credential_no_snapshot_check"
    CHECK ("lane" <> 'credential_sync' OR "renderDataSnapshot" IS NULL);

-- `abandoned` means retries were exhausted. The credential lane has none, so a
-- row in that state would be reporting a retry schedule that does not exist.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_credential_not_abandoned_check"
    CHECK ("lane" <> 'credential_sync' OR "status" <> 'abandoned');

-- A keyed hash nobody can name the key for cannot be verified after a
-- rotation, which makes it indistinguishable from no hash at all.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_rendered_hash_key_check"
    CHECK (("renderedHash" IS NULL) = ("renderedHashKeyVersion" IS NULL));

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_attempts_check"
    CHECK ("attempts" >= 0);

-- Purging the snapshot is a fact about a snapshot that existed. Stamping it on
-- a row that never had one would misreport the retention sweep's coverage.
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_snapshot_purge_check"
    CHECK ("snapshotPurgedAt" IS NULL OR "renderDataSnapshot" IS NULL);
