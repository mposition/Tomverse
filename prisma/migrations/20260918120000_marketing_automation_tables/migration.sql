-- The four marketing automation tables, with the invariants the application
-- must not be able to lose.
--
-- Contract: docs/policy/marketing-automation.md. The design is
-- marketing/marketing-s1-implementation-plan.md S1c (amendment rounds r4 to r6)
-- in the private docs repository; every rule it names is in the public policy.
--
-- Why so much of this is in the database rather than in the store module: these
-- rows are evidence. A published post, the approval it rested on and the facts
-- the claim was checked against are read back later to answer what was said and
-- on whose authority. `npm run check:protected-table-writers` refuses the direct
-- writes it can read in source, and lib/marketingStore.ts parses every JSON
-- column before it writes; both are application-side and neither sees a write
-- that reached the table another way. What is below applies to every row
-- however it arrived.
--
-- What the database enforces:
--
-- 1. Closed lists, as CHECK constraints that repeat
--    lib/marketingAutomationSchema.ts. `npm run check:enum-constraints` compares
--    the two, so they cannot drift.
--
-- 2. Instagram and TikTok never reach autonomous mode
--    (docs/policy/marketing-automation.md O15). Neither platform lets the API
--    retract a post, so an autonomous mistake there cannot be undone by the
--    route that made it. Both sides are constrained, and the post-side trigger
--    reads the channel row from the schema its own table is in, so a temporary
--    table of the same name cannot answer for it.
--
-- 3. Per-channel posting caps are code constants and an operator override may
--    only lower them (docs/policy/marketing-automation.md §7.6). RedNote has no
--    API posting route at all, so it has no cap and an override on it is
--    refused outright rather than compared.
--
-- 4. Account transitions follow docs/policy/marketing-automation.md §8.2: a
--    pause is entered only from a live mode and the trigger records which one
--    itself, a reconnect returns the account to approval mode with a new
--    graduation epoch and a database-clock start time, and a resume into
--    autonomous mode carries a fresh operator reason and audit entry.
--
-- 5. Post status is a whitelist of movements, not a list of names. Nothing that
--    was dispatched can return to a state that says it never left, `publishedAt`
--    is written once, and a post that reached a platform can never be deleted.
--
-- 6. `history` is append-only. The single exception is retention, which must set
--    the transaction-local setting below, must not touch a row under legal hold,
--    may only drop `attempt` and `webhook_event` entries older than ninety days,
--    and must leave a summary and a compaction entry in their place. Everything
--    else, at any age, is refused.
--
-- 7. Retention anchors are the database's: `createdAt` and `retentionUntil` are
--    set by BEFORE INSERT triggers from the server clock and refused any later
--    change, so a caller cannot date a row into the past and delete it.
--
-- An honest note about the setting in 6. The application uses one database role,
-- so `SET LOCAL tomverse.marketing_retention_compaction` is not a privilege
-- boundary -- any code in the application could set it. What it is is a second,
-- deliberate action that ordinary code never performs, so a purge cannot happen
-- by accident. It is not an authorisation on its own: the age, legal-hold and
-- shape rules below apply to every row whether or not it is set. Preventing a
-- deliberate purge as well needs a separate non-owner runtime role, which is a
-- recorded follow-up and not part of this slice (operator decision 2026-09-17:
-- mistakes are stopped, deliberate evasion is detected rather than made
-- impossible).

-- ---------------------------------------------------------------------------
-- Tables
--
-- The CREATE TABLE and CREATE INDEX statements below are exactly what
-- `prisma migrate diff` generates from the four models, so the column types,
-- nullability, defaults and Prisma-expressible indexes cannot drift from
-- prisma/schema.prisma. Everything schema.prisma cannot express -- CHECK
-- constraints, partial unique indexes, triggers -- is added after them, which is
-- how the ten existing CHECK constraints in this repository are carried.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "MarketingChannel" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccountRef" TEXT,
    "accountSlug" TEXT NOT NULL,
    "defaultLocale" TEXT NOT NULL,
    "allowedLocales" TEXT[],
    "connectionGeneration" INTEGER NOT NULL DEFAULT 1,
    "scopesDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "approvalStartedAt" TIMESTAMP(3),
    "graduatedAt" TIMESTAMP(3),
    "graduationEpoch" INTEGER NOT NULL DEFAULT 0,
    "graduationSnapshot" JSONB,
    "pausedAt" TIMESTAMP(3),
    "pausedFromMode" TEXT,
    "pauseReasonCode" TEXT,
    "lastResumeAuditLogId" TEXT,
    "lastResumeReasonCode" TEXT,
    "dailyCapOverride" INTEGER,
    "weeklyCapOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPost" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "logicalKey" TEXT NOT NULL,
    "envelope" JSONB,
    "envelopeDigest" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "templateId" TEXT,
    "templateDigest" TEXT,
    "claimIds" TEXT[],
    "assetIds" TEXT[],
    "claimRegistryVersion" INTEGER NOT NULL,
    "assetRegistryVersion" INTEGER NOT NULL,
    "factSnapshot" JSONB NOT NULL,
    "guardDecision" TEXT NOT NULL,
    "guardCodes" TEXT[],
    "guardRuleIds" TEXT[],
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "approvalAuditLogId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedDigest" TEXT,
    "approvalExpiresAt" TIMESTAMP(3),
    "reusableAsTemplate" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "slotDate" DATE,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "publishAttempt" INTEGER NOT NULL DEFAULT 0,
    "providerRequestKey" TEXT,
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "verifiedPublicAt" TIMESTAMP(3),
    "verificationMethod" TEXT,
    "errorCode" TEXT,
    "outcomeUnknownAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletionMethod" TEXT,
    "history" JSONB NOT NULL,
    "historyVersion" INTEGER NOT NULL DEFAULT 0,
    "contentPurgedAt" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingReport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVisibilityRun" (
    "id" TEXT NOT NULL,
    "promptSetVersion" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "searchMode" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "mentioned" BOOLEAN NOT NULL,
    "citedUrls" TEXT[],
    "answerDigest" TEXT NOT NULL,
    "accuracyFlags" JSONB,
    "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVisibilityRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingChannel_accountSlug_key" ON "MarketingChannel"("accountSlug");

-- CreateIndex
CREATE INDEX "MarketingChannel_status_idx" ON "MarketingChannel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingPost_logicalKey_key" ON "MarketingPost"("logicalKey");

-- CreateIndex
CREATE INDEX "MarketingPost_channelId_status_idx" ON "MarketingPost"("channelId", "status");

-- CreateIndex
CREATE INDEX "MarketingPost_status_scheduledAt_idx" ON "MarketingPost"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "MarketingPost_channelId_slotDate_idx" ON "MarketingPost"("channelId", "slotDate");

-- CreateIndex
CREATE INDEX "MarketingPost_createdAt_idx" ON "MarketingPost"("createdAt");

-- CreateIndex
CREATE INDEX "MarketingReport_kind_periodStart_idx" ON "MarketingReport"("kind", "periodStart");

-- CreateIndex
CREATE INDEX "MarketingReport_retentionUntil_idx" ON "MarketingReport"("retentionUntil");

-- CreateIndex
CREATE INDEX "AiVisibilityRun_runAt_idx" ON "AiVisibilityRun"("runAt");

-- CreateIndex
CREATE INDEX "AiVisibilityRun_promptSetVersion_promptId_idx" ON "AiVisibilityRun"("promptSetVersion", "promptId");

-- CreateIndex
CREATE INDEX "AiVisibilityRun_retentionUntil_idx" ON "AiVisibilityRun"("retentionUntil");

-- AddForeignKey
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "MarketingChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What prisma/schema.prisma cannot say
-- ---------------------------------------------------------------------------

-- Prisma writes a scalar list as `TEXT[]` with no NOT NULL: the client never
-- sends NULL, but SQL that reached the table another way could, and a NULL
-- array is not an empty one -- `'x' = ANY(NULL)` is NULL, so a rule written
-- against the column would silently stop applying.
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_arrays_are_present_check" CHECK ("allowedLocales" IS NOT NULL);
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_arrays_are_present_check" CHECK ("claimIds" IS NOT NULL AND "assetIds" IS NOT NULL AND "guardCodes" IS NOT NULL AND "guardRuleIds" IS NOT NULL);
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_arrays_are_present_check" CHECK ("citedUrls" IS NOT NULL);

-- The closed lists, repeating lib/marketingAutomationSchema.ts.
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_channel_check" CHECK ("channel" IN ('linkedin', 'x', 'facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'rednote'));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_provider_check" CHECK ("provider" IN ('zernio', 'manual'));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_status_check" CHECK ("status" IN ('connect_pending', 'approval_mode', 'autonomous_mode', 'paused', 'disconnected'));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_defaultLocale_check" CHECK ("defaultLocale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans'));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_pausedFromMode_check" CHECK ("pausedFromMode" IS NULL OR "pausedFromMode" IN ('approval_mode', 'autonomous_mode'));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_lastResumeReasonCode_check" CHECK ("lastResumeReasonCode" IS NULL OR "lastResumeReasonCode" IN ('incident_resolved', 'false_positive_pause', 'operator_review_complete'));

ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_locale_check" CHECK ("locale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_kind_check" CHECK ("kind" IN ('social', 'rednote_package', 'landing_variant', 'seo_pr_ref'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_guardDecision_check" CHECK ("guardDecision" IN ('reject', 'approval_required', 'autonomous_eligible'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_status_check" CHECK ("status" IN ('drafted', 'guard_rejected', 'pending_approval', 'approved', 'rejected', 'approval_expired', 'scheduled', 'publishing', 'published', 'failed', 'outcome_unknown', 'verified', 'removed_by_platform', 'deleted'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_mode_check" CHECK ("mode" IN ('approval', 'autonomous'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_verificationMethod_check" CHECK ("verificationMethod" IS NULL OR "verificationMethod" IN ('status_query', 'webhook', 'operator_sample'));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_deletionMethod_check" CHECK ("deletionMethod" IS NULL OR "deletionMethod" IN ('api_unpublish', 'operator_manual', 'platform_removed'));

ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_kind_check" CHECK ("kind" IN ('weekly_kpi', 'brief', 'market_intel', 'experiment_result', 'measurement_120d', 'comment_alerts', 'mainland_block_check', 'retention_run', 'webhook_shadow'));

ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_locale_check" CHECK ("locale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans'));
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_searchMode_check" CHECK ("searchMode" IN ('with_search', 'without_search'));

-- A manual account is an operator posting by hand, so there is no connected
-- account to reference; every other provider must name one.
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_external_ref_matches_provider_check" CHECK (("provider" = 'manual') = ("externalAccountRef" IS NULL));

-- System-generated internal name: this row's own channel, a hyphen and a small
-- number. Never a handle, display name or address, and never another channel's
-- prefix -- a LinkedIn row called `tiktok-1` would read as a TikTok account in
-- every report that groups by slug.
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_accountSlug_shape_check" CHECK ("accountSlug" ~ '^[a-z]+-[0-9]{1,3}$' AND "accountSlug" LIKE "channel" || '-%');

ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_locales_check" CHECK (pg_catalog.array_length("allowedLocales", 1) >= 1 AND "defaultLocale" = ANY ("allowedLocales") AND "allowedLocales" <@ ARRAY['en', 'ko', 'zh-Hant', 'zh-Hans']::TEXT[]);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_connectionGeneration_check" CHECK ("connectionGeneration" >= 1);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_policyVersion_check" CHECK ("policyVersion" >= 1);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_graduationEpoch_check" CHECK ("graduationEpoch" >= 0);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_cap_overrides_non_negative_check" CHECK (pg_catalog.coalesce("dailyCapOverride", 0) >= 0 AND pg_catalog.coalesce("weeklyCapOverride", 0) >= 0);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_autonomous_needs_graduation_check" CHECK ("status" <> 'autonomous_mode' OR ("graduatedAt" IS NOT NULL AND "graduationSnapshot" IS NOT NULL));
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_paused_records_when_check" CHECK ("status" <> 'paused' OR "pausedAt" IS NOT NULL);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_live_has_approval_start_check" CHECK ("status" NOT IN ('approval_mode', 'autonomous_mode') OR "approvalStartedAt" IS NOT NULL);
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_resume_is_recorded_together_check" CHECK (("lastResumeAuditLogId" IS NULL) = ("lastResumeReasonCode" IS NULL));

-- O15, on the channel side: an Instagram or TikTok account may not be
-- autonomous, may not carry a graduation, and may not have been paused out of
-- autonomous mode.
ALTER TABLE "MarketingChannel" ADD CONSTRAINT "MarketingChannel_no_autonomy_channels_check" CHECK (NOT ("channel" IN ('instagram', 'tiktok') AND ("status" = 'autonomous_mode' OR "graduatedAt" IS NOT NULL OR "pausedFromMode" = 'autonomous_mode')));

-- Autonomy is a property of an approved template, not of one draft.
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_autonomous_needs_template_check" CHECK ("mode" <> 'autonomous' OR ("guardDecision" = 'autonomous_eligible' AND "templateId" IS NOT NULL AND "templateDigest" IS NOT NULL));

-- An approval binds to the exact bytes it approved. Every clause is explicitly
-- NOT NULL: a comparison against a NULL digest is NULL, and a CHECK treats NULL
-- as satisfied, so leaving the digest out would have been a way past this rule
-- rather than a violation of it.
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_approval_binding_check" CHECK ("status" NOT IN ('approved', 'scheduled', 'publishing', 'published', 'verified') OR "mode" <> 'approval' OR ("approvalAuditLogId" IS NOT NULL AND "approvedDigest" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedDigest" = "envelopeDigest"));

ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_guard_rejected_check" CHECK ("status" <> 'guard_rejected' OR "guardDecision" = 'reject');

-- Purged means the content is gone and the digests remain, and the two states
-- cannot be told apart any other way.
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_purge_is_consistent_check" CHECK (("contentPurgedAt" IS NULL) = ("envelope" IS NOT NULL));

-- Once a request has gone to a platform the provider's idempotency key is set
-- and is the logical key, so a repeat can never become a second post.
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_dispatched_has_request_key_check" CHECK ("status" NOT IN ('publishing', 'published', 'verified', 'outcome_unknown', 'failed', 'removed_by_platform', 'deleted') OR ("providerRequestKey" IS NOT NULL AND "providerRequestKey" = "logicalKey" AND "publishAttempt" > 0));
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_providerRequestKey_check" CHECK ("providerRequestKey" IS NULL OR "providerRequestKey" = "logicalKey");

-- A post that has been published carries the moment it was, and every state it
-- can reach afterwards is reached from published or verified. The purge clock
-- reads this column first, so a NULL here would date a published post from its
-- draft.
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_published_records_when_check" CHECK ("status" NOT IN ('published', 'verified', 'removed_by_platform', 'deleted') OR "publishedAt" IS NOT NULL);

ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_externalUrl_check" CHECK ("externalUrl" IS NULL OR "externalUrl" LIKE 'https://%');
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_publishAttempt_check" CHECK ("publishAttempt" >= 0);
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_historyVersion_check" CHECK ("historyVersion" >= 0);
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_registry_versions_check" CHECK ("claimRegistryVersion" >= 1 AND "assetRegistryVersion" >= 1);

ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_period_check" CHECK ("periodStart" <= "periodEnd");

-- Equality, not an upper bound, and set by the trigger rather than the caller: a
-- writer that could choose the date would be setting its own row's life while
-- the column still looked policy-shaped
-- (docs/policy/marketing-automation.md §12.2).
ALTER TABLE "MarketingReport" ADD CONSTRAINT "MarketingReport_retentionUntil_check" CHECK ("retentionUntil" = "createdAt" + CASE "kind"
    WHEN 'weekly_kpi' THEN INTERVAL '24 months'
    WHEN 'brief' THEN INTERVAL '24 months'
    WHEN 'market_intel' THEN INTERVAL '24 months'
    WHEN 'experiment_result' THEN INTERVAL '36 months'
    WHEN 'measurement_120d' THEN INTERVAL '36 months'
    WHEN 'comment_alerts' THEN INTERVAL '90 days'
    WHEN 'webhook_shadow' THEN INTERVAL '90 days'
    WHEN 'mainland_block_check' THEN INTERVAL '12 months'
    WHEN 'retention_run' THEN INTERVAL '12 months'
END);

-- Every https check on an array goes through this: a CHECK constraint may not
-- contain a subquery, and this keeps the rule in one place. A CHECK resolves the
-- function by oid when the constraint is created, so no later search path can
-- point it elsewhere.
--
-- `bool_and` ignores NULL inputs, which would let ['https://ok', NULL] pass, so
-- a NULL element is tested explicitly rather than skipped.
CREATE OR REPLACE FUNCTION "marketing_all_https"("urls" TEXT[])
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.bool_and("url" IS NOT NULL AND "url" LIKE 'https://%')
    FROM pg_catalog.unnest("urls") AS "url"
$$ LANGUAGE sql;

-- The answer itself is never stored: what is kept is whether we were mentioned,
-- what was cited, and a digest that lets two runs be compared.
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_answerDigest_check" CHECK ("answerDigest" ~ '^[a-f0-9]{64}$');
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_citedUrls_check" CHECK ("marketing_all_https"("citedUrls"));
ALTER TABLE "AiVisibilityRun" ADD CONSTRAINT "AiVisibilityRun_retentionUntil_check" CHECK ("retentionUntil" = "runAt" + INTERVAL '24 months');

-- Partial unique indexes, which schema.prisma cannot express. The first stops
-- two rows claiming the same connected account; the second stops two posts
-- claiming the same provider idempotency key, which is what makes a repeated
-- publish one post rather than two.
CREATE UNIQUE INDEX "MarketingChannel_provider_externalAccountRef_key" ON "MarketingChannel"("provider", "externalAccountRef") WHERE "externalAccountRef" IS NOT NULL;
CREATE UNIQUE INDEX "MarketingPost_providerRequestKey_key" ON "MarketingPost"("providerRequestKey") WHERE "providerRequestKey" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- MarketingChannel: caps, identity, transitions, deletion
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "marketing_channel_caps_are_lower_only"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    daily_cap INTEGER;
    weekly_cap INTEGER;
BEGIN
    -- docs/policy/marketing-automation.md §7.6, duplicated from
    -- MARKETING_CHANNEL_CAPS in lib/marketingAutomationSchema.ts.
    -- tests/marketingAutomationSchema.test.mjs compares the two tables, so a
    -- change to one without the other fails. The ELSE is not unreachable
    -- defence: a value the CHECK constraint has not seen yet would otherwise
    -- raise `case_not_found`, which says nothing about what is wrong.
    CASE NEW."channel"
        WHEN 'linkedin' THEN daily_cap := 1; weekly_cap := 3;
        WHEN 'x' THEN daily_cap := 2; weekly_cap := 10;
        WHEN 'facebook' THEN daily_cap := 1; weekly_cap := 5;
        WHEN 'instagram' THEN daily_cap := 1; weekly_cap := 4;
        WHEN 'threads' THEN daily_cap := 2; weekly_cap := 7;
        WHEN 'youtube' THEN daily_cap := 1; weekly_cap := 2;
        WHEN 'tiktok' THEN daily_cap := 1; weekly_cap := 5;
        WHEN 'rednote' THEN daily_cap := NULL; weekly_cap := NULL;
        ELSE
            RAISE EXCEPTION 'MarketingChannel % has no posting cap for channel %', NEW."accountSlug", NEW."channel"
                USING ERRCODE = 'check_violation';
    END CASE;

    IF daily_cap IS NULL THEN
        IF NEW."dailyCapOverride" IS NOT NULL OR NEW."weeklyCapOverride" IS NOT NULL THEN
            RAISE EXCEPTION 'MarketingChannel % is a manual channel and has no posting cap to override', NEW."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."dailyCapOverride" IS NOT NULL AND NEW."dailyCapOverride" > daily_cap THEN
        RAISE EXCEPTION 'MarketingChannel % daily cap override % is above the policy cap %', NEW."accountSlug", NEW."dailyCapOverride", daily_cap
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."weeklyCapOverride" IS NOT NULL AND NEW."weeklyCapOverride" > weekly_cap THEN
        RAISE EXCEPTION 'MarketingChannel % weekly cap override % is above the policy cap %', NEW."accountSlug", NEW."weeklyCapOverride", weekly_cap
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_channel_caps_are_lower_only"
    BEFORE INSERT OR UPDATE ON "MarketingChannel"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_channel_caps_are_lower_only"();

-- A new account starts where every account starts.
CREATE OR REPLACE FUNCTION "marketing_channel_starts_connecting"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';

    IF NEW."status" <> 'connect_pending' THEN
        RAISE EXCEPTION 'MarketingChannel % must be created as connect_pending', NEW."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."graduatedAt" IS NOT NULL
        OR NEW."graduationSnapshot" IS NOT NULL
        OR NEW."graduationEpoch" <> 0
        OR NEW."pausedAt" IS NOT NULL
        OR NEW."pausedFromMode" IS NOT NULL
        OR NEW."lastResumeAuditLogId" IS NOT NULL
        OR NEW."approvalStartedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'MarketingChannel % cannot be created with a history it has not had', NEW."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_channel_starts_connecting"
    BEFORE INSERT ON "MarketingChannel"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_channel_starts_connecting"();

CREATE OR REPLACE FUNCTION "marketing_channel_identity_and_transitions"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    identity_changed BOOLEAN;
    server_now TIMESTAMP(3);
BEGIN
    server_now := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';

    -- What the account *is* never changes. A different platform or a different
    -- carrier is a different account, and every post already written against
    -- this row names it.
    IF NEW."channel" <> OLD."channel" OR NEW."provider" <> OLD."provider" THEN
        RAISE EXCEPTION 'MarketingChannel % identity is immutable', OLD."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."accountSlug" <> OLD."accountSlug" THEN
        RAISE EXCEPTION 'MarketingChannel % slug is immutable', OLD."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MarketingChannel % creation time is immutable', OLD."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."connectionGeneration" <> OLD."connectionGeneration"
        AND NEW."connectionGeneration" <> OLD."connectionGeneration" + 1 THEN
        RAISE EXCEPTION 'MarketingChannel % connection generation moves by one, not from % to %', OLD."accountSlug", OLD."connectionGeneration", NEW."connectionGeneration"
            USING ERRCODE = 'check_violation';
    END IF;

    -- docs/policy/marketing-automation.md §8.2: a reconnect, a scope change or
    -- a policy version change puts the account back in approval mode and starts
    -- a new graduation epoch. Anything the account earned under the previous
    -- connection was earned under permissions it no longer has. The start time
    -- is the server's, not the caller's, because it is what the graduation
    -- window is measured from.
    identity_changed := NEW."connectionGeneration" <> OLD."connectionGeneration"
        OR NEW."scopesDigest" <> OLD."scopesDigest"
        OR NEW."policyVersion" <> OLD."policyVersion";

    -- These two are checked before any branch returns, because they hold
    -- whatever else the write is doing. They used to sit after the reconnect
    -- branch, so a write that also changed the scopes digest reached that
    -- branch's `RETURN` and never passed this way: it could revive a
    -- disconnected account on its old connection generation, and rewrite the
    -- resume columns while doing it.
    IF NOT (OLD."status" = 'paused' AND NEW."status" = 'autonomous_mode')
        AND (NEW."lastResumeAuditLogId" IS DISTINCT FROM OLD."lastResumeAuditLogId"
            OR NEW."lastResumeReasonCode" IS DISTINCT FROM OLD."lastResumeReasonCode") THEN
        RAISE EXCEPTION 'MarketingChannel % records a resume reason only when it resumes into autonomous mode', OLD."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'disconnected' AND NEW."status" <> 'disconnected'
        AND NEW."connectionGeneration" <> OLD."connectionGeneration" + 1 THEN
        RAISE EXCEPTION 'MarketingChannel % reconnects only with a new connection generation', OLD."accountSlug"
            USING ERRCODE = 'check_violation';
    END IF;

    IF identity_changed THEN
        IF NEW."status" <> 'approval_mode'
            OR NEW."graduatedAt" IS NOT NULL
            OR NEW."graduationSnapshot" IS NOT NULL
            OR NEW."graduationEpoch" <> OLD."graduationEpoch" + 1 THEN
            RAISE EXCEPTION 'MarketingChannel % reconnect must return to approval mode with a new epoch', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;
        NEW."approvalStartedAt" := server_now;
        NEW."pausedAt" := NULL;
        NEW."pausedFromMode" := NULL;
        RETURN NEW;
    END IF;

    -- Outside a transition, the columns that record where the account has been
    -- do not move. Without this a caller could sit in `paused` and rewrite
    -- `pausedFromMode` to 'autonomous_mode', then resume into autonomy it never
    -- had.
    IF NEW."status" = OLD."status" THEN
        IF NEW."pausedFromMode" IS DISTINCT FROM OLD."pausedFromMode"
            OR NEW."pausedAt" IS DISTINCT FROM OLD."pausedAt"
            OR NEW."graduatedAt" IS DISTINCT FROM OLD."graduatedAt"
            OR NEW."graduationSnapshot" IS DISTINCT FROM OLD."graduationSnapshot"
            OR NEW."graduationEpoch" <> OLD."graduationEpoch"
            OR NEW."approvalStartedAt" IS DISTINCT FROM OLD."approvalStartedAt"
            OR NEW."lastResumeAuditLogId" IS DISTINCT FROM OLD."lastResumeAuditLogId"
            OR NEW."lastResumeReasonCode" IS DISTINCT FROM OLD."lastResumeReasonCode" THEN
            RAISE EXCEPTION 'MarketingChannel % lifecycle columns only change with its status', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- The whitelist. A pause is entered only from a live mode, so there is no
    -- path from connecting or disconnected into a paused state that a resume
    -- could then read as "it used to be autonomous".
    IF NOT (
        (OLD."status" = 'connect_pending' AND NEW."status" IN ('approval_mode', 'disconnected'))
        OR (OLD."status" = 'approval_mode' AND NEW."status" IN ('autonomous_mode', 'paused', 'disconnected'))
        OR (OLD."status" = 'autonomous_mode' AND NEW."status" IN ('approval_mode', 'paused', 'disconnected'))
        OR (OLD."status" = 'paused' AND NEW."status" IN ('approval_mode', 'autonomous_mode', 'disconnected'))
        OR (OLD."status" = 'disconnected' AND NEW."status" = 'approval_mode')
    ) THEN
        RAISE EXCEPTION 'MarketingChannel % cannot move from % to %', OLD."accountSlug", OLD."status", NEW."status"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" = 'paused' THEN
        -- The trigger records where the pause came from; a caller's value is
        -- ignored rather than checked, because a value that is only checked can
        -- be supplied correctly and then edited.
        NEW."pausedFromMode" := OLD."status";
        NEW."pausedAt" := server_now;
    END IF;

    IF NEW."status" = 'approval_mode' THEN
        NEW."approvalStartedAt" := server_now;
        NEW."pausedAt" := NULL;
        NEW."pausedFromMode" := NULL;
        NEW."graduatedAt" := NULL;
        NEW."graduationSnapshot" := NULL;
    END IF;

    IF NEW."status" = 'autonomous_mode' THEN
        IF NEW."graduatedAt" IS NULL OR NEW."graduationSnapshot" IS NULL THEN
            RAISE EXCEPTION 'MarketingChannel % cannot become autonomous without a graduation', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."status" = 'paused' THEN
            IF OLD."pausedFromMode" IS DISTINCT FROM 'autonomous_mode' THEN
                RAISE EXCEPTION 'MarketingChannel % was not autonomous before it was paused', OLD."accountSlug"
                    USING ERRCODE = 'check_violation';
            END IF;

            -- docs/policy/marketing-automation.md §8.2: returning an account to
            -- autonomy is an operator decision, and it carries the reason and
            -- the audit entry that records it. The store checks that the entry
            -- is a human one with the right action; the trigger checks that
            -- there is a new one at all.
            IF NEW."lastResumeAuditLogId" IS NULL
                OR NEW."lastResumeReasonCode" IS NULL
                OR NEW."lastResumeAuditLogId" IS NOT DISTINCT FROM OLD."lastResumeAuditLogId" THEN
                RAISE EXCEPTION 'MarketingChannel % resume into autonomous mode needs a new operator reason and audit entry', OLD."accountSlug"
                    USING ERRCODE = 'check_violation';
            END IF;

            NEW."pausedAt" := NULL;
            NEW."pausedFromMode" := NULL;
        END IF;
    END IF;

    IF NEW."status" = 'disconnected' THEN
        NEW."pausedAt" := NULL;
        NEW."pausedFromMode" := NULL;
        NEW."graduatedAt" := NULL;
        NEW."graduationSnapshot" := NULL;
        NEW."approvalStartedAt" := NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_channel_identity_and_transitions"
    BEFORE UPDATE ON "MarketingChannel"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_channel_identity_and_transitions"();

-- Disconnection is a status. A deleted channel row would orphan the posts that
-- name it and erase which account said what.
CREATE OR REPLACE FUNCTION "marketing_channel_is_never_deleted"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'MarketingChannel % is not deletable; disconnect it instead', OLD."accountSlug"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_channel_is_never_deleted"
    BEFORE DELETE ON "MarketingChannel"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_channel_is_never_deleted"();

-- ---------------------------------------------------------------------------
-- MarketingPost: the channel it belongs to
-- ---------------------------------------------------------------------------

-- The channel is read from the schema this trigger's own table lives in, built
-- with %I from `TG_TABLE_SCHEMA`. An unqualified name would be resolved against
-- the session's search path, and a temporary table called "MarketingChannel"
-- would then answer for the real one -- with the foreign key still pointing at
-- the real row, so an autonomous post could be admitted against an Instagram
-- account by a session that had created one.
CREATE OR REPLACE FUNCTION "marketing_post_matches_its_channel"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    target_channel TEXT;
    allowed_locales TEXT[];
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT "channel", "allowedLocales" FROM %I."MarketingChannel" WHERE "id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    )
    INTO target_channel, allowed_locales
    USING NEW."channelId";

    IF target_channel IS NULL THEN
        RAISE EXCEPTION 'MarketingPost % names a channel that does not exist', NEW."id"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- A post in a language the account does not publish in is not a translation
    -- problem; it is a post nobody decided to make.
    IF NOT (NEW."locale" = ANY (allowed_locales)) THEN
        RAISE EXCEPTION 'MarketingPost % is in % and the account does not publish in it', NEW."id", NEW."locale"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."mode" = 'autonomous' AND target_channel IN ('instagram', 'tiktok') THEN
        RAISE EXCEPTION 'MarketingPost % cannot be autonomous on %', NEW."id", target_channel
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_matches_its_channel"
    BEFORE INSERT OR UPDATE OF "mode", "channelId", "locale" ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_matches_its_channel"();

-- A draft starts at version zero with exactly one history entry, and that entry
-- says it is a draft. A row that arrived with a history already in it would be
-- a record of events that are not in this database.
CREATE OR REPLACE FUNCTION "marketing_post_starts_as_one_draft"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';

    IF NEW."historyVersion" <> 0 THEN
        RAISE EXCEPTION 'MarketingPost % must start at history version zero', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF pg_catalog.jsonb_array_length(NEW."history") <> 1
        OR NEW."history" -> 0 ->> 'type' IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'MarketingPost % must start with one draft history entry', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" NOT IN ('drafted', 'guard_rejected') THEN
        RAISE EXCEPTION 'MarketingPost % must be created as a draft, not as %', NEW."id", NEW."status"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."publishedAt" IS NOT NULL
        OR NEW."publishAttempt" <> 0
        OR NEW."providerRequestKey" IS NOT NULL
        OR NEW."externalPostId" IS NOT NULL
        OR NEW."contentPurgedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'MarketingPost % cannot be created as though it had been published', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_starts_as_one_draft"
    BEFORE INSERT ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_starts_as_one_draft"();

-- ---------------------------------------------------------------------------
-- MarketingPost: what an update may do
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "marketing_post_update_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    retention_running BOOLEAN;
    last_failure_at TIMESTAMP(3);
    old_length INTEGER;
    new_length INTEGER;
    kept JSONB;
    kept_length INTEGER;
    removed JSONB;
    removed_length INTEGER;
    tail JSONB;
    element JSONB;
    summarised_type TEXT;
    summary JSONB;
    now_utc TIMESTAMP(3);
BEGIN
    retention_running := pg_catalog.current_setting('tomverse.marketing_retention_compaction', true) = 'on';
    now_utc := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
    old_length := pg_catalog.jsonb_array_length(OLD."history");
    new_length := pg_catalog.jsonb_array_length(NEW."history");

    IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MarketingPost % creation time is immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."logicalKey" <> OLD."logicalKey" THEN
        RAISE EXCEPTION 'MarketingPost % logical key is immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- docs/policy/marketing-automation.md §12.2 dates the content purge from the
    -- publication, so the publication time is written once and never again.
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
        RAISE EXCEPTION 'MarketingPost % publication time is written once', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL
        AND NOT (OLD."status" IN ('publishing', 'outcome_unknown') AND NEW."status" = 'published') THEN
        RAISE EXCEPTION 'MarketingPost % records a publication time only when it becomes published', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- Legal hold: while it is on, retention does not touch the row at all, and
    -- turning it off is an operator action with its own route and audit entry
    -- (S2), never something a purge transaction can do to clear its own way.
    IF retention_running AND OLD."legalHold" THEN
        RAISE EXCEPTION 'MarketingPost % is under legal hold', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF retention_running AND OLD."legalHold" IS DISTINCT FROM NEW."legalHold" THEN
        RAISE EXCEPTION 'MarketingPost % legal hold is not changed by retention', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- The status whitelist (S1 plan r5). Everything a dispatch reached stays
    -- reached: nothing may go back to a state that says the post never left.
    IF NEW."status" <> OLD."status" THEN
        IF NOT (
            (OLD."status" = 'drafted' AND NEW."status" IN ('guard_rejected', 'pending_approval'))
            OR (OLD."status" = 'pending_approval' AND NEW."status" IN ('approved', 'rejected', 'approval_expired'))
            OR (OLD."status" = 'approved' AND NEW."status" IN ('scheduled', 'approval_expired'))
            OR (OLD."status" = 'scheduled' AND NEW."status" IN ('publishing', 'approval_expired'))
            OR (OLD."status" = 'publishing' AND NEW."status" IN ('published', 'failed', 'outcome_unknown'))
            OR (OLD."status" = 'published' AND NEW."status" IN ('verified', 'removed_by_platform', 'deleted'))
            OR (OLD."status" = 'verified' AND NEW."status" IN ('removed_by_platform', 'deleted'))
            OR (OLD."status" = 'outcome_unknown' AND NEW."status" IN ('published', 'failed'))
            OR (OLD."status" = 'failed' AND NEW."status" = 'scheduled')
        ) THEN
            RAISE EXCEPTION 'MarketingPost % cannot move from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'check_violation';
        END IF;

        -- A post that has become published carries the moment it did. The purge
        -- clock is `COALESCE(publishedAt, createdAt)`, so leaving it NULL would
        -- date a post published today from whenever its draft was written --
        -- and an old draft published today would be purgeable immediately.
        IF NEW."status" = 'published' AND NEW."publishedAt" IS NULL THEN
            RAISE EXCEPTION 'MarketingPost % cannot become published without recording when', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- A confirmed failure is re-queued by a person, never by a retry
        -- (docs/policy/marketing-automation.md §2). The store checks that the
        -- audit entry is a human requeue for this content; the trigger checks
        -- that the approval is new and dated after the failure it is answering,
        -- which it reads from the history rather than from the previous
        -- approval -- an approval older than the failure is not a decision about
        -- it.
        IF OLD."status" = 'failed' AND NEW."status" = 'scheduled' THEN
            SELECT pg_catalog.max((("entry" ->> 'at')::TIMESTAMPTZ) AT TIME ZONE 'UTC')
            INTO last_failure_at
            FROM pg_catalog.jsonb_array_elements(OLD."history") AS "h"("entry")
            WHERE "entry" ->> 'type' = 'attempt'
              AND "entry" ->> 'outcome' = 'failed';

            IF NEW."approvalAuditLogId" IS NULL
                OR NEW."approvalAuditLogId" IS NOT DISTINCT FROM OLD."approvalAuditLogId"
                OR NEW."approvedAt" IS NULL
                OR (OLD."approvedAt" IS NOT NULL AND NEW."approvedAt" <= OLD."approvedAt")
                OR NEW."approvedDigest" IS DISTINCT FROM NEW."envelopeDigest" THEN
                RAISE EXCEPTION 'MarketingPost % is re-queued only by a fresh approval of its current content', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;

            IF last_failure_at IS NULL THEN
                RAISE EXCEPTION 'MarketingPost % is failed with no failed attempt in its history', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;

            IF NEW."approvedAt" <= last_failure_at THEN
                RAISE EXCEPTION 'MarketingPost % re-queue approval predates the failure it answers', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    -- The envelope only ever disappears, and only as a purge of content old
    -- enough to purge (docs/policy/marketing-automation.md §12.2: twenty-four
    -- months from publication, or from creation for a post never published).
    IF OLD."envelope" IS NULL AND NEW."envelope" IS NOT NULL THEN
        RAISE EXCEPTION 'MarketingPost % content cannot come back after a purge', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."envelope" IS NOT NULL AND NEW."envelope" IS NULL THEN
        IF NOT retention_running THEN
            RAISE EXCEPTION 'MarketingPost % content is only purged by retention', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."contentPurgedAt" IS NULL THEN
            RAISE EXCEPTION 'MarketingPost % purge must record when it happened', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        IF pg_catalog.coalesce(OLD."publishedAt", OLD."createdAt") > now_utc - INTERVAL '24 months' THEN
            RAISE EXCEPTION 'MarketingPost % content is not yet twenty-four months old', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW."envelopeDigest" <> OLD."envelopeDigest" AND OLD."envelope" IS NULL THEN
        RAISE EXCEPTION 'MarketingPost % digest cannot change after a purge', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."history" IS NOT DISTINCT FROM OLD."history" AND NEW."historyVersion" = OLD."historyVersion" THEN
        RETURN NEW;
    END IF;

    IF NEW."historyVersion" <> OLD."historyVersion" + 1 THEN
        RAISE EXCEPTION 'MarketingPost % history version moves by one, not from % to %', OLD."id", OLD."historyVersion", NEW."historyVersion"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT retention_running THEN
        -- Append-only: the old array is the start of the new one, unchanged.
        IF new_length < old_length THEN
            RAISE EXCEPTION 'MarketingPost % history cannot lose entries', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        IF old_length > 0 THEN
            SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
            INTO kept
            FROM pg_catalog.jsonb_array_elements(NEW."history")
                WITH ORDINALITY AS "element"("entry", "ordinality")
            WHERE "ordinality" <= old_length;

            IF kept IS DISTINCT FROM OLD."history" THEN
                RAISE EXCEPTION 'MarketingPost % history is append-only', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        -- Retention writes the summary and compaction entries. A caller that
        -- could append one could claim entries had been removed that never
        -- existed.
        FOR element IN
            SELECT "entry"
            FROM pg_catalog.jsonb_array_elements(NEW."history")
                WITH ORDINALITY AS "added"("entry", "ordinality")
            WHERE "ordinality" > old_length
        LOOP
            IF element ->> 'type' IN ('retention_summary', 'retention_compaction') THEN
                RAISE EXCEPTION 'MarketingPost % retention entries are written by retention', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;

        RETURN NEW;
    END IF;

    -- Compaction, and it is default-deny (S1 plan r5): the only entries that may
    -- leave are attempts and webhook ids older than ninety days, the entries
    -- that stay keep their order and their bytes, and what replaces the removed
    -- ones says how many there were and when.
    --
    -- No history entry type carries prose, so there is nothing here to redact:
    -- an entry either survives verbatim or is one of the two detail types this
    -- allows to go. If an entry type ever carries text, this trigger has to
    -- learn the redaction case before that type is added.
    --
    -- Membership is by containment, which does not count duplicates, so two
    -- byte-identical entries are treated as one: compaction must remove both or
    -- neither. Every entry carries its own `at`, so identical pairs do not arise
    -- in practice; the effect of the simplification is to refuse a compaction,
    -- never to admit one.
    SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
    INTO kept
    FROM pg_catalog.jsonb_array_elements(OLD."history")
        WITH ORDINALITY AS "element"("entry", "ordinality")
    WHERE NEW."history" @> pg_catalog.jsonb_build_array("entry");

    kept := pg_catalog.coalesce(kept, '[]'::JSONB);
    kept_length := pg_catalog.jsonb_array_length(kept);

    SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
    INTO removed
    FROM pg_catalog.jsonb_array_elements(OLD."history")
        WITH ORDINALITY AS "element"("entry", "ordinality")
    WHERE NOT (NEW."history" @> pg_catalog.jsonb_build_array("entry"));

    removed := pg_catalog.coalesce(removed, '[]'::JSONB);
    removed_length := pg_catalog.jsonb_array_length(removed);

    IF removed_length = 0 THEN
        RAISE EXCEPTION 'MarketingPost % compaction removed nothing', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    FOR element IN SELECT "entry" FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
    LOOP
        IF element ->> 'type' NOT IN ('attempt', 'webhook_event') THEN
            RAISE EXCEPTION 'MarketingPost % cannot compact a % entry at any age', OLD."id", element ->> 'type'
                USING ERRCODE = 'check_violation';
        END IF;
        IF (element ->> 'at')::TIMESTAMPTZ > pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
            RAISE EXCEPTION 'MarketingPost % cannot compact an entry younger than ninety days', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    -- A failed post's only way out is a re-queue, and both the store and the
    -- transition above read the last failed attempt from this history to check
    -- that the operator's approval came after it. A summary does not carry an
    -- outcome, so compacting that attempt away would leave the post failed with
    -- no exit at all -- which retention is not for.
    IF OLD."status" = 'failed' THEN
        SELECT pg_catalog.max((("entry" ->> 'at')::TIMESTAMPTZ) AT TIME ZONE 'UTC')
        INTO last_failure_at
        FROM pg_catalog.jsonb_array_elements(OLD."history") AS "h"("entry")
        WHERE "entry" ->> 'type' = 'attempt'
          AND "entry" ->> 'outcome' = 'failed';

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
            WHERE "entry" ->> 'type' = 'attempt'
              AND "entry" ->> 'outcome' = 'failed'
              AND ((("entry" ->> 'at')::TIMESTAMPTZ) AT TIME ZONE 'UTC') = last_failure_at
        ) THEN
            RAISE EXCEPTION 'MarketingPost % is failed and its last failed attempt is what a re-queue is measured against', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Everything kept is still there, in order, at the front.
    SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
    INTO tail
    FROM pg_catalog.jsonb_array_elements(NEW."history")
        WITH ORDINALITY AS "element"("entry", "ordinality")
    WHERE "ordinality" <= kept_length;

    IF pg_catalog.coalesce(tail, '[]'::JSONB) IS DISTINCT FROM kept THEN
        RAISE EXCEPTION 'MarketingPost % compaction changed the entries it kept', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
    INTO tail
    FROM pg_catalog.jsonb_array_elements(NEW."history")
        WITH ORDINALITY AS "element"("entry", "ordinality")
    WHERE "ordinality" > kept_length;

    tail := pg_catalog.coalesce(tail, '[]'::JSONB);

    -- Exactly one closing entry, at the end, counting exactly what left. Not
    -- "the last one is a compaction": a second compaction entry earlier in the
    -- tail would be a record of a removal that never happened.
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(tail) AS "t"("entry")
        WHERE "entry" ->> 'type' = 'retention_compaction'
    ) <> 1 THEN
        RAISE EXCEPTION 'MarketingPost % compaction writes exactly one closing entry', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF new_length < 1
        OR NEW."history" -> (new_length - 1) ->> 'type' IS DISTINCT FROM 'retention_compaction'
        OR (NEW."history" -> (new_length - 1) ->> 'removedEntryCount')::INTEGER IS DISTINCT FROM removed_length THEN
        RAISE EXCEPTION 'MarketingPost % compaction must end with a retention_compaction entry counting what it removed', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- Nothing in the tail but well-formed summaries and that closing entry.
    --
    -- Every comparison here is NULL-safe on purpose. `x ->> 'type'` is NULL when
    -- the key is absent, `NULL NOT IN (...)` is NULL, and `IF NULL` does not
    -- raise -- so an entry with no `type` at all used to pass this loop, and a
    -- `count(DISTINCT ...)` below skipped it again. The result was a history
    -- carrying `{}` that the store's schema then refused to parse, which would
    -- have stopped every later append to that post.
    FOR element IN SELECT "entry" FROM pg_catalog.jsonb_array_elements(tail) AS "t"("entry")
    LOOP
        IF pg_catalog.jsonb_typeof(element) IS DISTINCT FROM 'object'
            OR pg_catalog.coalesce(element ->> 'type', '') NOT IN ('retention_summary', 'retention_compaction') THEN
            RAISE EXCEPTION 'MarketingPost % compaction may only add summaries', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        -- The exact key set, so a summary cannot carry anything else along with
        -- it. "C" collation because the comparison is against a literal array
        -- and must not depend on the database's locale.
        IF element ->> 'type' = 'retention_summary' THEN
            IF (
                SELECT pg_catalog.array_agg("key" ORDER BY "key" COLLATE "C")
                FROM pg_catalog.jsonb_object_keys(element) AS "k"("key")
            ) IS DISTINCT FROM ARRAY['at', 'count', 'firstAt', 'lastAt', 'summarises', 'type'] THEN
                RAISE EXCEPTION 'MarketingPost % retention summary is not the shape a summary has', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            IF (
                SELECT pg_catalog.array_agg("key" ORDER BY "key" COLLATE "C")
                FROM pg_catalog.jsonb_object_keys(element) AS "k"("key")
            ) IS DISTINCT FROM ARRAY['at', 'removedEntryCount', 'type'] THEN
                RAISE EXCEPTION 'MarketingPost % retention compaction entry is not the shape it has', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END LOOP;

    -- A summary for something that did not leave is a record of a removal that
    -- never happened, so the counts have to match in both directions. Counting
    -- rows rather than distinct values: two summaries of the same kind are two
    -- rows here and one distinct value, and the per-kind check below would then
    -- be the only thing that noticed.
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(tail) AS "t"("entry")
        WHERE "entry" ->> 'type' = 'retention_summary'
    ) <> (
        SELECT pg_catalog.count(DISTINCT "entry" ->> 'type')
        FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
    ) THEN
        RAISE EXCEPTION 'MarketingPost % compaction summarises something it did not remove', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- One summary per kind of entry that left, saying how many and when.
    FOR summarised_type IN SELECT DISTINCT "entry" ->> 'type' FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
    LOOP
        IF (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_array_elements(tail) AS "t"("entry")
            WHERE "entry" ->> 'type' = 'retention_summary'
              AND "entry" ->> 'summarises' = summarised_type
        ) <> 1 THEN
            RAISE EXCEPTION 'MarketingPost % needs exactly one summary of its removed % entries', OLD."id", summarised_type
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT "entry"
        INTO summary
        FROM pg_catalog.jsonb_array_elements(tail) AS "t"("entry")
        WHERE "entry" ->> 'type' = 'retention_summary'
          AND "entry" ->> 'summarises' = summarised_type;

        IF (summary ->> 'count')::INTEGER IS DISTINCT FROM (
            SELECT pg_catalog.count(*)::INTEGER
            FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
            WHERE "entry" ->> 'type' = summarised_type
        ) THEN
            RAISE EXCEPTION 'MarketingPost % summary of % entries does not count them', OLD."id", summarised_type
                USING ERRCODE = 'check_violation';
        END IF;

        -- The span is the whole point of the summary: it is what is left to say
        -- when the entries themselves are gone.
        IF (summary ->> 'firstAt')::TIMESTAMPTZ IS DISTINCT FROM (
            SELECT pg_catalog.min(("entry" ->> 'at')::TIMESTAMPTZ)
            FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
            WHERE "entry" ->> 'type' = summarised_type
        ) OR (summary ->> 'lastAt')::TIMESTAMPTZ IS DISTINCT FROM (
            SELECT pg_catalog.max(("entry" ->> 'at')::TIMESTAMPTZ)
            FROM pg_catalog.jsonb_array_elements(removed) AS "r"("entry")
            WHERE "entry" ->> 'type' = summarised_type
        ) THEN
            RAISE EXCEPTION 'MarketingPost % summary of % entries does not span them', OLD."id", summarised_type
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_update_is_bounded"
    BEFORE UPDATE ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_update_is_bounded"();

-- Rejected and expired drafts are deleted after ninety days
-- (docs/policy/marketing-automation.md §12.2), and only if nothing was ever sent
-- to a platform for them. Everything else is a ledger row: its content is purged
-- and its digests stay, so the question "what was posted and on whose authority"
-- still has an answer.
CREATE OR REPLACE FUNCTION "marketing_post_delete_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF pg_catalog.current_setting('tomverse.marketing_retention_compaction', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'MarketingPost % is only deleted by retention', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."legalHold" THEN
        RAISE EXCEPTION 'MarketingPost % is under legal hold', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" NOT IN ('guard_rejected', 'rejected', 'approval_expired') THEN
        RAISE EXCEPTION 'MarketingPost % has status % and is not a deletable draft', OLD."id", OLD."status"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."publishAttempt" <> 0
        OR OLD."publishedAt" IS NOT NULL
        OR OLD."providerRequestKey" IS NOT NULL
        OR OLD."externalPostId" IS NOT NULL THEN
        RAISE EXCEPTION 'MarketingPost % reached a platform and is not deletable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."createdAt" > pg_catalog.clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '90 days' THEN
        RAISE EXCEPTION 'MarketingPost % is not yet ninety days old', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_delete_is_bounded"
    BEFORE DELETE ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_delete_is_bounded"();

-- ---------------------------------------------------------------------------
-- MarketingReport and AiVisibilityRun: the clock is the database's
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "marketing_report_sets_its_retention"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    -- Both columns are overwritten, so the caller's values never reach the row.
    -- A caller that could date a report into the past could delete it in the
    -- same transaction that wrote it.
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
    NEW."retentionUntil" := NEW."createdAt" + CASE NEW."kind"
        WHEN 'weekly_kpi' THEN INTERVAL '24 months'
        WHEN 'brief' THEN INTERVAL '24 months'
        WHEN 'market_intel' THEN INTERVAL '24 months'
        WHEN 'experiment_result' THEN INTERVAL '36 months'
        WHEN 'measurement_120d' THEN INTERVAL '36 months'
        WHEN 'comment_alerts' THEN INTERVAL '90 days'
        WHEN 'webhook_shadow' THEN INTERVAL '90 days'
        WHEN 'mainland_block_check' THEN INTERVAL '12 months'
        WHEN 'retention_run' THEN INTERVAL '12 months'
        ELSE NULL
    END;

    IF NEW."retentionUntil" IS NULL THEN
        RAISE EXCEPTION 'MarketingReport kind % has no retention period', NEW."kind"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_report_sets_its_retention"
    BEFORE INSERT ON "MarketingReport"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_report_sets_its_retention"();

CREATE OR REPLACE FUNCTION "ai_visibility_run_sets_its_retention"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW."createdAt" := pg_catalog.clock_timestamp() AT TIME ZONE 'UTC';
    NEW."retentionUntil" := NEW."runAt" + INTERVAL '24 months';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_visibility_run_sets_its_retention"
    BEFORE INSERT ON "AiVisibilityRun"
    FOR EACH ROW
    EXECUTE FUNCTION "ai_visibility_run_sets_its_retention"();

-- The anchors a deletion is measured from do not move.
CREATE OR REPLACE FUNCTION "marketing_report_anchors_are_immutable"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        OR NEW."retentionUntil" IS DISTINCT FROM OLD."retentionUntil"
        OR NEW."kind" <> OLD."kind" THEN
        RAISE EXCEPTION 'MarketingReport % retention anchors are immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_report_anchors_are_immutable"
    BEFORE UPDATE ON "MarketingReport"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_report_anchors_are_immutable"();

CREATE OR REPLACE FUNCTION "ai_visibility_run_anchors_are_immutable"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        OR NEW."retentionUntil" IS DISTINCT FROM OLD."retentionUntil"
        OR NEW."runAt" IS DISTINCT FROM OLD."runAt" THEN
        RAISE EXCEPTION 'AiVisibilityRun % retention anchors are immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_visibility_run_anchors_are_immutable"
    BEFORE UPDATE ON "AiVisibilityRun"
    FOR EACH ROW
    EXECUTE FUNCTION "ai_visibility_run_anchors_are_immutable"();

CREATE OR REPLACE FUNCTION "marketing_retained_row_delete_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF pg_catalog.current_setting('tomverse.marketing_retention_compaction', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION '% row is only deleted by retention', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;

    -- Both tables carry `retentionUntil`, and plpgsql resolves a record's fields
    -- when the trigger runs, so one function serves both without building any
    -- SQL.
    IF OLD."retentionUntil" > pg_catalog.clock_timestamp() AT TIME ZONE 'UTC' THEN
        RAISE EXCEPTION '% row is retained until %', TG_TABLE_NAME, OLD."retentionUntil"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_report_delete_is_bounded"
    BEFORE DELETE ON "MarketingReport"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_retained_row_delete_is_bounded"();

CREATE TRIGGER "ai_visibility_run_delete_is_bounded"
    BEFORE DELETE ON "AiVisibilityRun"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_retained_row_delete_is_bounded"();
