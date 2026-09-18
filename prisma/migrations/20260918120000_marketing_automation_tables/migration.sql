-- The four marketing automation tables, with the invariants the application
-- must not be able to lose.
--
-- Contract: docs/policy/marketing-automation.md. The design is
-- marketing/marketing-s1-implementation-plan.md S1c in the private docs
-- repository; the rules it names are all in the public policy.
--
-- Why so much of this is in the database rather than in the store module:
-- these rows are evidence. A published post, the approval it rested on and the
-- facts the claim was checked against are read back later to answer what was
-- said and on whose authority. `npm run check:protected-table-writers` refuses
-- the direct writes it can read in source, and lib/marketingStore.ts parses
-- every JSON column before it writes; both are application-side and neither
-- sees a write that reached the table another way. What is below applies to
-- every row however it arrived.
--
-- What the database enforces here:
--
-- 1. Closed lists, as CHECK constraints that repeat
--    lib/marketingAutomationSchema.ts. `npm run check:enum-constraints`
--    compares the two, so they cannot drift.
--
-- 2. Instagram and TikTok never reach autonomous mode
--    (docs/policy/marketing-automation.md O15). Neither platform lets the API
--    retract a post, so an autonomous mistake there cannot be undone by the
--    route that made it. Both sides are constrained: the channel may not hold
--    an autonomous status, and a post may not claim autonomous mode against
--    such a channel. The post-side trigger reads the channel row FOR SHARE, and
--    the channel's kind is immutable, so there is no window in which the answer
--    changes under it.
--
-- 3. Per-channel posting caps are code constants and an operator override may
--    only lower them (docs/policy/marketing-automation.md §7.6). The table is
--    duplicated below in `marketing_channel_caps_are_lower_only`;
--    tests/marketingAutomationSchema.db.test.ts and the unit test assert the
--    SQL table and MARKETING_CHANNEL_CAPS are equal, so the duplicate cannot
--    drift silently. RedNote has no API posting route at all, so it has no cap
--    and an override on it is refused outright rather than compared.
--
-- 4. Account transitions follow docs/policy/marketing-automation.md §8.2: a
--    reconnect or a scope or policy change returns the account to approval
--    mode and increments the graduation epoch, and a resume from paused is
--    approval mode unless the account was autonomous before and is not an O15
--    channel.
--
-- 5. `history` is append-only with a version that must advance by exactly one,
--    and `envelope` may only become NULL as a purge. The single exception is
--    retention (docs/policy/marketing-automation.md §12.2), which must set the
--    transaction-local setting named below, must not touch a row under legal
--    hold, and must end the history with a `retention_compaction` entry.
--
-- 6. Deletes: a channel is never deleted (disconnection is a status); a post is
--    deletable only while it is a rejected or expired draft older than 90 days,
--    under the retention setting and no legal hold; a report or a visibility
--    run only after its own `retentionUntil`. Published rows are purged of
--    content and keep their digests.
--
-- An honest note about the setting in 5 and 6. The application uses one
-- database role, so `SET LOCAL tomverse.marketing_retention_compaction` is not
-- a privilege boundary -- any code in the application could set it. What it is
-- is a second, deliberate action that ordinary code never performs, so a purge
-- cannot happen by accident, and the protected-table-writers check refuses the
-- name outside the modules on its allowlist. Preventing a deliberate purge as
-- well needs a separate non-owner runtime role, which is a recorded follow-up
-- and not part of this slice (operator decision 2026-09-17: mistakes are
-- stopped, deliberate evasion is detected rather than made impossible).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "MarketingChannel" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccountRef" TEXT,
    "accountSlug" TEXT NOT NULL,
    "defaultLocale" TEXT NOT NULL,
    "allowedLocales" TEXT[] NOT NULL,
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
    "dailyCapOverride" INTEGER,
    "weeklyCapOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingChannel_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "MarketingChannel_channel_check" CHECK ("channel" IN ('linkedin', 'x', 'facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'rednote')),
    CONSTRAINT "MarketingChannel_provider_check" CHECK ("provider" IN ('zernio', 'manual')),
    CONSTRAINT "MarketingChannel_status_check" CHECK ("status" IN ('connect_pending', 'approval_mode', 'autonomous_mode', 'paused', 'disconnected')),
    CONSTRAINT "MarketingChannel_defaultLocale_check" CHECK ("defaultLocale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans')),
    CONSTRAINT "MarketingChannel_pausedFromMode_check" CHECK ("pausedFromMode" IS NULL OR "pausedFromMode" IN ('approval_mode', 'autonomous_mode')),

    -- A manual account is an operator posting by hand, so there is no connected
    -- account to reference; every other provider must name one.
    CONSTRAINT "MarketingChannel_external_ref_matches_provider_check" CHECK (("provider" = 'manual') = ("externalAccountRef" IS NULL)),

    -- System-generated internal name (channel, hyphen, small number). Never a
    -- handle, display name or address.
    CONSTRAINT "MarketingChannel_accountSlug_shape_check" CHECK ("accountSlug" ~ '^[a-z]+-[0-9]{1,3}$'),

    CONSTRAINT "MarketingChannel_locales_check" CHECK (pg_catalog.array_length("allowedLocales", 1) >= 1 AND "defaultLocale" = ANY ("allowedLocales")),
    CONSTRAINT "MarketingChannel_connectionGeneration_check" CHECK ("connectionGeneration" >= 1),
    CONSTRAINT "MarketingChannel_policyVersion_check" CHECK ("policyVersion" >= 1),
    CONSTRAINT "MarketingChannel_graduationEpoch_check" CHECK ("graduationEpoch" >= 0),
    CONSTRAINT "MarketingChannel_cap_overrides_non_negative_check" CHECK (pg_catalog.coalesce("dailyCapOverride", 0) >= 0 AND pg_catalog.coalesce("weeklyCapOverride", 0) >= 0),

    CONSTRAINT "MarketingChannel_autonomous_needs_graduation_check" CHECK ("status" <> 'autonomous_mode' OR ("graduatedAt" IS NOT NULL AND "graduationSnapshot" IS NOT NULL)),
    CONSTRAINT "MarketingChannel_paused_records_origin_check" CHECK ("status" <> 'paused' OR ("pausedAt" IS NOT NULL AND "pausedFromMode" IS NOT NULL)),
    CONSTRAINT "MarketingChannel_live_has_approval_start_check" CHECK ("status" NOT IN ('approval_mode', 'autonomous_mode') OR "approvalStartedAt" IS NOT NULL),

    -- O15, on the channel side: an Instagram or TikTok account may not be
    -- autonomous, may not carry a graduation, and may not have been paused out
    -- of autonomous mode.
    CONSTRAINT "MarketingChannel_no_autonomy_channels_check" CHECK (NOT ("channel" IN ('instagram', 'tiktok') AND ("status" = 'autonomous_mode' OR "graduatedAt" IS NOT NULL OR "pausedFromMode" = 'autonomous_mode')))
);

CREATE UNIQUE INDEX "MarketingChannel_accountSlug_key" ON "MarketingChannel"("accountSlug");
CREATE UNIQUE INDEX "MarketingChannel_provider_externalAccountRef_key" ON "MarketingChannel"("provider", "externalAccountRef") WHERE "externalAccountRef" IS NOT NULL;
CREATE INDEX "MarketingChannel_status_idx" ON "MarketingChannel"("status");

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
    "claimIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "assetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "claimRegistryVersion" INTEGER NOT NULL,
    "assetRegistryVersion" INTEGER NOT NULL,
    "factSnapshot" JSONB NOT NULL,
    "guardDecision" TEXT NOT NULL,
    "guardCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "guardRuleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
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
    "history" JSONB NOT NULL DEFAULT '[]'::JSONB,
    "historyVersion" INTEGER NOT NULL DEFAULT 0,
    "contentPurgedAt" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingPost_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "MarketingPost_locale_check" CHECK ("locale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans')),
    CONSTRAINT "MarketingPost_kind_check" CHECK ("kind" IN ('social', 'rednote_package', 'landing_variant', 'seo_pr_ref')),
    CONSTRAINT "MarketingPost_guardDecision_check" CHECK ("guardDecision" IN ('reject', 'approval_required', 'autonomous_eligible')),
    CONSTRAINT "MarketingPost_status_check" CHECK ("status" IN ('drafted', 'guard_rejected', 'pending_approval', 'approved', 'rejected', 'approval_expired', 'scheduled', 'publishing', 'published', 'failed', 'outcome_unknown', 'verified', 'removed_by_platform', 'deleted')),
    CONSTRAINT "MarketingPost_mode_check" CHECK ("mode" IN ('approval', 'autonomous')),
    CONSTRAINT "MarketingPost_verificationMethod_check" CHECK ("verificationMethod" IS NULL OR "verificationMethod" IN ('status_query', 'webhook', 'operator_sample')),
    CONSTRAINT "MarketingPost_deletionMethod_check" CHECK ("deletionMethod" IS NULL OR "deletionMethod" IN ('api_unpublish', 'operator_manual', 'platform_removed')),

    -- Autonomy is a property of an approved template, not of one draft.
    CONSTRAINT "MarketingPost_autonomous_needs_template_check" CHECK ("mode" <> 'autonomous' OR ("guardDecision" = 'autonomous_eligible' AND "templateId" IS NOT NULL AND "templateDigest" IS NOT NULL)),

    -- An approval binds to the exact bytes it approved. A post that moved past
    -- approval in approval mode names the audit entry and matches its digest.
    CONSTRAINT "MarketingPost_approval_binding_check" CHECK ("status" NOT IN ('approved', 'scheduled', 'publishing', 'published', 'verified') OR "mode" <> 'approval' OR ("approvalAuditLogId" IS NOT NULL AND "approvedDigest" = "envelopeDigest")),

    CONSTRAINT "MarketingPost_guard_rejected_check" CHECK ("status" <> 'guard_rejected' OR "guardDecision" = 'reject'),

    -- Purged means the content is gone and the digests remain, and the two
    -- states cannot be told apart any other way.
    CONSTRAINT "MarketingPost_purge_is_consistent_check" CHECK (("contentPurgedAt" IS NULL) = ("envelope" IS NOT NULL)),

    CONSTRAINT "MarketingPost_externalUrl_check" CHECK ("externalUrl" IS NULL OR "externalUrl" LIKE 'https://%'),
    CONSTRAINT "MarketingPost_publishAttempt_check" CHECK ("publishAttempt" >= 0),
    CONSTRAINT "MarketingPost_historyVersion_check" CHECK ("historyVersion" >= 0),
    CONSTRAINT "MarketingPost_registry_versions_check" CHECK ("claimRegistryVersion" >= 1 AND "assetRegistryVersion" >= 1),

    -- The provider's idempotency key is the logical key or nothing. A second
    -- key would be a second identity for the same post.
    CONSTRAINT "MarketingPost_providerRequestKey_check" CHECK ("providerRequestKey" IS NULL OR "providerRequestKey" = "logicalKey"),

    CONSTRAINT "MarketingPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "MarketingChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MarketingPost_logicalKey_key" ON "MarketingPost"("logicalKey");
CREATE UNIQUE INDEX "MarketingPost_providerRequestKey_key" ON "MarketingPost"("providerRequestKey") WHERE "providerRequestKey" IS NOT NULL;
CREATE INDEX "MarketingPost_channelId_status_idx" ON "MarketingPost"("channelId", "status");
CREATE INDEX "MarketingPost_status_scheduledAt_idx" ON "MarketingPost"("status", "scheduledAt");
CREATE INDEX "MarketingPost_channelId_slotDate_idx" ON "MarketingPost"("channelId", "slotDate");
CREATE INDEX "MarketingPost_createdAt_idx" ON "MarketingPost"("createdAt");

CREATE TABLE "MarketingReport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingReport_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "MarketingReport_kind_check" CHECK ("kind" IN ('weekly_kpi', 'brief', 'market_intel', 'experiment_result', 'measurement_120d', 'comment_alerts', 'mainland_block_check', 'retention_run', 'webhook_shadow')),
    CONSTRAINT "MarketingReport_period_check" CHECK ("periodStart" <= "periodEnd"),

    -- Equality, not an upper bound: a writer that could choose any earlier date
    -- would be setting its own retention while the column still looked
    -- policy-shaped (docs/policy/marketing-automation.md §12.2).
    CONSTRAINT "MarketingReport_retentionUntil_check" CHECK ("retentionUntil" = "createdAt" + CASE "kind"
        WHEN 'weekly_kpi' THEN INTERVAL '24 months'
        WHEN 'brief' THEN INTERVAL '24 months'
        WHEN 'market_intel' THEN INTERVAL '24 months'
        WHEN 'experiment_result' THEN INTERVAL '36 months'
        WHEN 'measurement_120d' THEN INTERVAL '36 months'
        WHEN 'comment_alerts' THEN INTERVAL '90 days'
        WHEN 'webhook_shadow' THEN INTERVAL '90 days'
        WHEN 'mainland_block_check' THEN INTERVAL '12 months'
        WHEN 'retention_run' THEN INTERVAL '12 months'
    END)
);

CREATE INDEX "MarketingReport_kind_periodStart_idx" ON "MarketingReport"("kind", "periodStart");
CREATE INDEX "MarketingReport_retentionUntil_idx" ON "MarketingReport"("retentionUntil");

-- Every https check on an array goes through this: a CHECK constraint may not
-- contain a subquery, and this keeps the rule in one place rather than in a
-- cast-and-regex expression nobody can read.
CREATE OR REPLACE FUNCTION "marketing_all_https"("urls" TEXT[])
RETURNS boolean
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.bool_and("url" LIKE 'https://%')
    FROM pg_catalog.unnest("urls") AS "url"
$$ LANGUAGE sql;

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
    "citedUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "answerDigest" TEXT NOT NULL,
    "accuracyFlags" JSONB,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVisibilityRun_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "AiVisibilityRun_locale_check" CHECK ("locale" IN ('en', 'ko', 'zh-Hant', 'zh-Hans')),
    CONSTRAINT "AiVisibilityRun_searchMode_check" CHECK ("searchMode" IN ('with_search', 'without_search')),

    -- The answer itself is never stored: what is kept is whether we were
    -- mentioned, what was cited, and a digest that lets two runs be compared.
    CONSTRAINT "AiVisibilityRun_answerDigest_check" CHECK ("answerDigest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "AiVisibilityRun_citedUrls_check" CHECK ("marketing_all_https"("citedUrls")),
    CONSTRAINT "AiVisibilityRun_retentionUntil_check" CHECK ("retentionUntil" = "runAt" + INTERVAL '24 months')
);

CREATE INDEX "AiVisibilityRun_runAt_idx" ON "AiVisibilityRun"("runAt");
CREATE INDEX "AiVisibilityRun_promptSetVersion_promptId_idx" ON "AiVisibilityRun"("promptSetVersion", "promptId");
CREATE INDEX "AiVisibilityRun_retentionUntil_idx" ON "AiVisibilityRun"("retentionUntil");

-- ---------------------------------------------------------------------------
-- The retention setting
-- ---------------------------------------------------------------------------

-- True only inside a transaction that deliberately set it. `current_setting`
-- with the missing_ok argument returns NULL rather than raising when the
-- setting was never set in this session.
CREATE OR REPLACE FUNCTION "marketing_retention_is_running"()
RETURNS boolean
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT pg_catalog.current_setting('tomverse.marketing_retention_compaction', true) = 'on'
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------------
-- MarketingChannel: identity, transitions and caps
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
    -- MARKETING_CHANNEL_CAPS in lib/marketingAutomationSchema.ts. The two are
    -- compared by tests/marketingAutomationSchema.test.mjs against this text,
    -- so a change to one without the other fails.
    CASE NEW."channel"
        WHEN 'linkedin' THEN daily_cap := 1; weekly_cap := 3;
        WHEN 'x' THEN daily_cap := 2; weekly_cap := 10;
        WHEN 'facebook' THEN daily_cap := 1; weekly_cap := 5;
        WHEN 'instagram' THEN daily_cap := 1; weekly_cap := 4;
        WHEN 'threads' THEN daily_cap := 2; weekly_cap := 7;
        WHEN 'youtube' THEN daily_cap := 1; weekly_cap := 2;
        WHEN 'tiktok' THEN daily_cap := 1; weekly_cap := 5;
        WHEN 'rednote' THEN daily_cap := NULL; weekly_cap := NULL;
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

CREATE OR REPLACE FUNCTION "marketing_channel_identity_and_transitions"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    identity_changed BOOLEAN;
BEGIN
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

    IF NEW."connectionGeneration" <> OLD."connectionGeneration"
        AND NEW."connectionGeneration" <> OLD."connectionGeneration" + 1 THEN
        RAISE EXCEPTION 'MarketingChannel % connection generation moves by one, not from % to %', OLD."accountSlug", OLD."connectionGeneration", NEW."connectionGeneration"
            USING ERRCODE = 'check_violation';
    END IF;

    -- docs/policy/marketing-automation.md §8.2: a reconnect, a scope change or
    -- a policy version change puts the account back in approval mode and starts
    -- a new graduation epoch. Anything the account earned under the previous
    -- connection was earned under permissions it no longer has.
    identity_changed := NEW."connectionGeneration" <> OLD."connectionGeneration"
        OR NEW."scopesDigest" <> OLD."scopesDigest"
        OR NEW."policyVersion" <> OLD."policyVersion";

    IF identity_changed THEN
        IF NEW."status" <> 'approval_mode'
            OR NEW."graduatedAt" IS NOT NULL
            OR NEW."graduationSnapshot" IS NOT NULL
            OR NEW."graduationEpoch" <> OLD."graduationEpoch" + 1
            OR NEW."approvalStartedAt" IS NULL
            OR (OLD."approvalStartedAt" IS NOT NULL AND NEW."approvalStartedAt" <= OLD."approvalStartedAt") THEN
            RAISE EXCEPTION 'MarketingChannel % reconnect must return to approval mode with a new epoch', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."status" <> OLD."status" THEN
        IF NOT (
            (OLD."status" = 'connect_pending' AND NEW."status" = 'approval_mode')
            OR (OLD."status" = 'approval_mode' AND NEW."status" = 'autonomous_mode')
            OR (OLD."status" IN ('connect_pending', 'approval_mode', 'autonomous_mode') AND NEW."status" = 'paused')
            OR (OLD."status" = 'paused' AND NEW."status" = 'approval_mode')
            OR (OLD."status" = 'paused' AND NEW."status" = 'autonomous_mode')
            OR NEW."status" = 'disconnected'
        ) THEN
            RAISE EXCEPTION 'MarketingChannel % cannot move from % to %', OLD."accountSlug", OLD."status", NEW."status"
                USING ERRCODE = 'check_violation';
        END IF;

        -- A resume into autonomous mode is only a return to where the account
        -- already was. Everything else resumes into approval mode.
        IF OLD."status" = 'paused' AND NEW."status" = 'autonomous_mode'
            AND OLD."pausedFromMode" IS DISTINCT FROM 'autonomous_mode' THEN
            RAISE EXCEPTION 'MarketingChannel % was not autonomous before it was paused', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."status" = 'paused' AND OLD."status" IN ('approval_mode', 'autonomous_mode')
            AND NEW."pausedFromMode" IS DISTINCT FROM OLD."status" THEN
            RAISE EXCEPTION 'MarketingChannel % must record the mode it was paused from', OLD."accountSlug"
                USING ERRCODE = 'check_violation';
        END IF;
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
-- MarketingPost: autonomy, history, purge, delete
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "marketing_post_autonomy_matches_channel"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    target_channel TEXT;
BEGIN
    IF NEW."mode" <> 'autonomous' THEN
        RETURN NEW;
    END IF;

    -- FOR SHARE: the channel row cannot be deleted or have its kind changed
    -- under this check. The kind is immutable anyway (see the identity
    -- trigger), so the lock closes the remaining case rather than a race that
    -- could otherwise change the answer.
    SELECT "channel" INTO target_channel
    FROM "MarketingChannel"
    WHERE "id" = NEW."channelId"
    FOR SHARE;

    IF target_channel IS NULL THEN
        RAISE EXCEPTION 'MarketingPost % names a channel that does not exist', NEW."id"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF target_channel IN ('instagram', 'tiktok') THEN
        RAISE EXCEPTION 'MarketingPost % cannot be autonomous on %', NEW."id", target_channel
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_autonomy_matches_channel"
    BEFORE INSERT OR UPDATE OF "mode", "channelId" ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_autonomy_matches_channel"();

-- A draft starts at version zero with exactly one history entry, and that entry
-- says it is a draft. A row that arrived with a history already in it would be
-- a record of events that are not in this database.
CREATE OR REPLACE FUNCTION "marketing_post_starts_as_one_draft"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW."historyVersion" <> 0 THEN
        RAISE EXCEPTION 'MarketingPost % must start at history version zero', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF pg_catalog.jsonb_array_length(NEW."history") <> 1
        OR NEW."history" -> 0 ->> 'type' IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'MarketingPost % must start with one draft history entry', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_starts_as_one_draft"
    BEFORE INSERT ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_starts_as_one_draft"();

CREATE OR REPLACE FUNCTION "marketing_post_update_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    retention_running BOOLEAN;
    old_length INTEGER;
    new_length INTEGER;
    prefix JSONB;
BEGIN
    retention_running := "marketing_retention_is_running"();
    old_length := pg_catalog.jsonb_array_length(OLD."history");
    new_length := pg_catalog.jsonb_array_length(NEW."history");

    -- Legal hold: while it is on, retention does not touch the row at all, and
    -- turning it off is an operator action with its own route and audit entry
    -- (S2), never something a purge transaction can do to clear its own way.
    IF retention_running AND OLD."legalHold" THEN
        RAISE EXCEPTION 'MarketingPost % is under legal hold', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."legalHold" AND NOT NEW."legalHold" AND retention_running THEN
        RAISE EXCEPTION 'MarketingPost % legal hold is not released by retention', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- The envelope only ever disappears, and only as a purge.
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
    END IF;

    IF NEW."envelopeDigest" <> OLD."envelopeDigest" AND OLD."envelope" IS NULL THEN
        RAISE EXCEPTION 'MarketingPost % digest cannot change after a purge', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."history" IS DISTINCT FROM OLD."history" OR NEW."historyVersion" <> OLD."historyVersion" THEN
        IF NEW."historyVersion" <> OLD."historyVersion" + 1 THEN
            RAISE EXCEPTION 'MarketingPost % history version moves by one, not from % to %', OLD."id", OLD."historyVersion", NEW."historyVersion"
                USING ERRCODE = 'check_violation';
        END IF;

        IF retention_running THEN
            -- Compaction is the one edit that may drop entries. It still has to
            -- say so at the end, so a shortened history is never silent.
            IF new_length < 1
                OR NEW."history" -> (new_length - 1) ->> 'type' IS DISTINCT FROM 'retention_compaction' THEN
                RAISE EXCEPTION 'MarketingPost % compaction must end with a retention_compaction entry', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            IF new_length < old_length THEN
                RAISE EXCEPTION 'MarketingPost % history cannot lose entries', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;

            IF old_length = 0 THEN
                prefix := '[]'::JSONB;
            ELSE
                SELECT pg_catalog.jsonb_agg("entry" ORDER BY "ordinality")
                INTO prefix
                FROM pg_catalog.jsonb_array_elements(NEW."history")
                    WITH ORDINALITY AS "element"("entry", "ordinality")
                WHERE "ordinality" <= old_length;
            END IF;

            IF prefix IS DISTINCT FROM OLD."history" THEN
                RAISE EXCEPTION 'MarketingPost % history is append-only', OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "marketing_post_update_is_bounded"
    BEFORE UPDATE ON "MarketingPost"
    FOR EACH ROW
    EXECUTE FUNCTION "marketing_post_update_is_bounded"();

-- Rejected and expired drafts are deleted after ninety days
-- (docs/policy/marketing-automation.md §12.2). Everything else is a ledger row:
-- its content is purged and its digests stay, so the question "what was posted
-- and on whose authority" still has an answer.
CREATE OR REPLACE FUNCTION "marketing_post_delete_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT "marketing_retention_is_running"() THEN
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

    IF OLD."createdAt" > pg_catalog.clock_timestamp() - INTERVAL '90 days' THEN
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
-- MarketingReport and AiVisibilityRun: delete only after retentionUntil
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "marketing_retained_row_delete_is_bounded"()
RETURNS trigger
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT "marketing_retention_is_running"() THEN
        RAISE EXCEPTION '% row is only deleted by retention', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;

    -- Both tables carry `retentionUntil`, and plpgsql resolves a record's
    -- fields when the trigger runs, so one function serves both without
    -- building any SQL.
    IF OLD."retentionUntil" > pg_catalog.clock_timestamp() THEN
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
