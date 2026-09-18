-- Durable Prompt Refiner staging approval provenance.
--
-- This migration creates no stage and authorizes no execution. The predecessor
-- migration deliberately had no seed; if any stage nevertheless exists, its
-- provenance cannot be reconstructed safely, so deployment stops instead of
-- backfilling guesses.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "PromptRefinerReservationStage") THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row';
    END IF;
END;
$$;

ALTER TABLE "PromptRefinerReservationStage"
    ADD COLUMN "admissionVersion" TEXT NOT NULL,
    ADD COLUMN "proposalVersion" TEXT NOT NULL,
    ADD COLUMN "proposalDigest" TEXT NOT NULL,
    ADD COLUMN "evidenceBundleDigest" TEXT NOT NULL,
    ADD COLUMN "evidenceManifestSha256" TEXT NOT NULL,
    ADD COLUMN "historicalSourceRef" TEXT NOT NULL,
    ADD COLUMN "historicalSourceIdentityDigest" TEXT NOT NULL,
    ADD COLUMN "corpusDigest" TEXT NOT NULL,
    ADD COLUMN "runtimeCommitSha" TEXT NOT NULL,
    ADD COLUMN "runtimeSourceIdentityDigest" TEXT NOT NULL,
    ADD COLUMN "runtimeSourceManifest" JSONB NOT NULL,
    ADD COLUMN "runtimeSourceManifestDigest" TEXT NOT NULL,
    ADD COLUMN "runtimeEnvironment" TEXT NOT NULL,
    ADD COLUMN "runtimeDeploymentId" TEXT NOT NULL,
    ADD COLUMN "executionManifest" JSONB NOT NULL,
    ADD COLUMN "executionManifestDigest" TEXT NOT NULL,
    ADD COLUMN "approvalExpiresAt" TIMESTAMP(3) NOT NULL,
    ADD COLUMN "authorizationAuditLogId" TEXT NOT NULL;

-- The application canonicalizer sorts object keys and preserves array order.
-- Keep the DB-side digest check independent from any caller-supplied boolean.
CREATE FUNCTION "prompt_refiner_canonical_json"(value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    rendered TEXT;
BEGIN
    CASE jsonb_typeof(value)
        WHEN 'object' THEN
            SELECT '{' || COALESCE(string_agg(to_jsonb(item.key)::TEXT || ':' || "prompt_refiner_canonical_json"(item.value), ',' ORDER BY item.key COLLATE "C"), '') || '}'
            INTO rendered FROM jsonb_each(value) AS item;
        WHEN 'array' THEN
            SELECT '[' || COALESCE(string_agg("prompt_refiner_canonical_json"(item.value), ',' ORDER BY item.ordinality), '') || ']'
            INTO rendered FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, ordinality);
        ELSE rendered := value::TEXT;
    END CASE;
    RETURN rendered;
END;
$$;

CREATE FUNCTION "prompt_refiner_sha256_json"(value JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT 'sha256:' || encode(sha256(convert_to("prompt_refiner_canonical_json"($1), 'UTF8')), 'hex')
$$;

CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"(
    manifest JSONB,
    commit_sha TEXT,
    source_identity_digest TEXT,
    manifest_digest TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    expected_file_count CONSTANT INTEGER := 186;
    maximum_total_size_bytes CONSTANT NUMERIC := 16777216;
    expected_paths CONSTANT TEXT[] := ARRAY[
        '.gitattributes',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'prisma/schema.prisma',
        'prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql',
        'apps/mobile/package.json',
        'packages/chat-core/package.json',
        'packages/ui-tokens/package.json',
        'app/api/admin/prompt-refiner/shadow-stage/route.ts',
        'lib/accountEmails.ts',
        'lib/activeAiModel.ts',
        'lib/adminAudit.ts',
        'lib/adminAuditIntegrityCore.ts',
        'lib/adminAuditSystemActors.ts',
        'lib/adminAuth.ts',
        'lib/adminAuthCore.ts',
        'lib/adminReauthentication.ts',
        'lib/adminReauthenticationCore.ts',
        'lib/anthropicPromptCaching.ts',
        'lib/apiCacheControlPolicy.ts',
        'lib/apiSecurity.ts',
        'lib/appDefaults.ts',
        'lib/appSettings.ts',
        'lib/assistantKnowledgeGuide.ts',
        'lib/assistantPackageImportAccess.ts',
        'lib/assistantProfileAccess.ts',
        'lib/auth.ts',
        'lib/billingEmails.ts',
        'lib/billingPlanDefaults.ts',
        'lib/chatAdmissionCore.ts',
        'lib/chatAttemptCostLedger.ts',
        'lib/chatConcurrencyCore.ts',
        'lib/chatCostGuardrails.ts',
        'lib/chatCostSafetyCore.ts',
        'lib/chatCreditAllocation.ts',
        'lib/chatInputLimits.ts',
        'lib/chatLimitDecisionCore.ts',
        'lib/chatLimitDecisions.ts',
        'lib/chatMultiAttemptSettlement.ts',
        'lib/chatProviderHolds.ts',
        'lib/chatRateLimitCore.ts',
        'lib/chatRequestLease.ts',
        'lib/chatSecurity.ts',
        'lib/chatStarterAccess.ts',
        'lib/chatTokenEstimate.ts',
        'lib/chatTokenQuotaCore.ts',
        'lib/chatUsageBucketCount.ts',
        'lib/chatUsageKey.ts',
        'lib/clientIp.ts',
        'lib/credentialEmailLane.ts',
        'lib/creditDebt.ts',
        'lib/creditLedger.ts',
        'lib/csp.ts',
        'lib/databaseError.ts',
        'lib/deepResearchSettlementHandoff.ts',
        'lib/deepseekUsageAdapter.ts',
        'lib/deepseekUsageAdapterCore.ts',
        'lib/documentLanguage.ts',
        'lib/e2eTestMode.ts',
        'lib/email.ts',
        'lib/emailAuditHash.ts',
        'lib/emailConsentToken.ts',
        'lib/emailFeatureFlags.ts',
        'lib/emailJurisdictionCore.ts',
        'lib/emailLogin.ts',
        'lib/emailLoginEmails.ts',
        'lib/emailPreferenceCore.ts',
        'lib/emailPreferences.ts',
        'lib/emailProviderPort.ts',
        'lib/emailProviderPortCore.ts',
        'lib/emailSendLock.ts',
        'lib/emailSendLockCore.ts',
        'lib/emailSendRetryCore.ts',
        'lib/emailSendingIdentity.ts',
        'lib/emailSendingIdentityCore.ts',
        'lib/emailSentIdentityCore.ts',
        'lib/emailSuppression.ts',
        'lib/emailSuppressionAuthority.ts',
        'lib/emailSuppressionAuthorityCore.ts',
        'lib/emailSuppressionCauses.ts',
        'lib/emailSuppressionCore.ts',
        'lib/emailTemplateDefinitions.ts',
        'lib/emailTemplateMetadataCore.ts',
        'lib/emailTemplateRegistry.ts',
        'lib/emailTypography.ts',
        'lib/externalContinuationAccess.ts',
        'lib/externalImportAccess.ts',
        'lib/foundingTesterPassCore.ts',
        'lib/imageGenerationAccess.ts',
        'lib/language.ts',
        'lib/managedSlack.ts',
        'lib/marketingConsentConfirmationEmail.ts',
        'lib/marketingEmailLayout.ts',
        'lib/marketingRoutes.ts',
        'lib/memoryAccess.ts',
        'lib/mobileAccessToken.ts',
        'lib/mobileAccessTokenCore.ts',
        'lib/mobileAuthContract.ts',
        'lib/mobileAuthKeyring.ts',
        'lib/mobileAuthService.ts',
        'lib/mobileDeploymentBinding.ts',
        'lib/mobileRefreshRotationCore.ts',
        'lib/mobileRefreshToken.ts',
        'lib/mobileRevocationFreshnessCore.ts',
        'lib/mobileSessionAuthorization.ts',
        'lib/mobileSessionSnapshotCache.ts',
        'lib/modelGenerationCompatibility.ts',
        'lib/modelLaunchEmail.ts',
        'lib/modelLifecycleDailyEmail.ts',
        'lib/modelLifecycleDailyReportCore.ts',
        'lib/modelPricing.ts',
        'lib/modelRegistry.ts',
        'lib/modelRegistryShared.ts',
        'lib/models.ts',
        'lib/nativeAppCors.ts',
        'lib/nativeBearerGate.ts',
        'lib/oauthTokenCrypto.ts',
        'lib/operationalMonitoring.ts',
        'lib/operationalMonitoringCore.ts',
        'lib/operatorAlertProbeCore.ts',
        'lib/originProtection.ts',
        'lib/perplexityResponseCore.ts',
        'lib/perplexityResponseEvents.ts',
        'lib/perplexitySearchMetadataCore.ts',
        'lib/perplexityUsageCapture.ts',
        'lib/perplexityUsageCore.ts',
        'lib/postgresConnectionConfigCore.mjs',
        'lib/prisma.ts',
        'lib/productAnnouncementEmail.ts',
        'lib/promptInjectionAudit.ts',
        'lib/promptRefinerAccess.ts',
        'lib/promptRefinerExecutionContract.ts',
        'lib/promptRefinerModelPrompt.ts',
        'lib/promptRefinerReservationAuthority.ts',
        'lib/promptRefinerReservationCore.ts',
        'lib/promptRefinerShadowAdmissionCore.ts',
        'lib/promptRefinerShadowHarness.ts',
        'lib/promptRefinerShadowJournal.ts',
        'lib/promptRefinerShadowSource.ts',
        'lib/promptRefinerStageAdmission.ts',
        'lib/promptRefinerStageAdmissionCore.ts',
        'lib/promptRefinerSuggestion.ts',
        'lib/providerBalanceCore.ts',
        'lib/providerBilling.ts',
        'lib/providerCostBudget.ts',
        'lib/providerCreditAlertsCore.ts',
        'lib/providerCredits.ts',
        'lib/providerErrorClassification.ts',
        'lib/providerFallbackCandidates.ts',
        'lib/providerHealthPolicyCore.ts',
        'lib/providerMonitoring.ts',
        'lib/providerProbe.ts',
        'lib/providerPublicStatusCore.ts',
        'lib/providerUsageAccounting.ts',
        'lib/providerUsageCost.ts',
        'lib/providerVerification.ts',
        'lib/publicSnapshotCache.ts',
        'lib/publicUrl.ts',
        'lib/requestOrigin.ts',
        'lib/routerDevelopmentBenchmark.ts',
        'lib/routingAttemptStore.ts',
        'lib/searchProviderBudget.ts',
        'lib/securityAudit.ts',
        'lib/sessionRevocationCore.ts',
        'lib/sessionSecurity.ts',
        'lib/slackMessageTemplateCore.ts',
        'lib/staticMarketingCsp.ts',
        'lib/svixSignature.ts',
        'lib/theme.ts',
        'lib/tokenEstimateShadow.ts',
        'lib/tokenEstimateShadowRecorder.ts',
        'lib/turnstile.ts',
        'lib/userDailyUsage.ts',
        'lib/userOperationalSecurity.ts',
        'lib/userTimeZone.ts',
        'lib/voiceInputAccess.ts',
        'lib/webSearchBackendPricing.ts',
        'lib/webSearchBackendRuntime.ts',
        'lib/webSearchBackends.ts',
        'lib/webSearchCapability.ts',
        'lib/webSearchCeilingBreachStore.ts',
        'lib/webSearchCitations.ts',
        'lib/webSearchCredits.ts',
        'lib/webSearchNativeCostReservation.ts',
        'proxy.ts'
    ];
    files JSONB;
    entry JSONB;
    index INTEGER;
    actual_total_size_bytes NUMERIC := 0;
BEGIN
    IF jsonb_typeof(manifest) <> 'object'
       OR manifest <> jsonb_build_object(
            'schemaVersion', 'prompt-refiner-runtime-source-manifest-v2',
            'commitSha', commit_sha,
            'totalSizeBytes', manifest->'totalSizeBytes',
            'files', manifest->'files'
       )
       OR manifest->>'commitSha' <> commit_sha
       OR jsonb_typeof(manifest->'totalSizeBytes') <> 'number'
       OR manifest->>'totalSizeBytes' !~ '^[1-9][0-9]*$'
       OR (manifest->>'totalSizeBytes')::NUMERIC > maximum_total_size_bytes
       OR jsonb_typeof(manifest->'files') <> 'array'
       OR array_length(expected_paths, 1) <> expected_file_count
       OR jsonb_array_length(manifest->'files') <> expected_file_count THEN
        RETURN FALSE;
    END IF;
    files := manifest->'files';
    FOR index IN 1..array_length(expected_paths, 1) LOOP
        entry := files->(index - 1);
        IF jsonb_typeof(entry) <> 'object'
           OR entry <> jsonb_build_object(
                'path', expected_paths[index],
                'sizeBytes', entry->'sizeBytes',
                'sha256', entry->'sha256'
           )
           OR entry->>'path' <> expected_paths[index]
           OR jsonb_typeof(entry->'sizeBytes') <> 'number'
           OR entry->>'sizeBytes' !~ '^[1-9][0-9]*$'
           OR (entry->>'sizeBytes')::NUMERIC > 8388608
           OR jsonb_typeof(entry->'sha256') <> 'string'
           OR entry->>'sha256' !~ '^[a-f0-9]{64}$' THEN
            RETURN FALSE;
        END IF;
        actual_total_size_bytes := actual_total_size_bytes + (entry->>'sizeBytes')::NUMERIC;
    END LOOP;
    RETURN actual_total_size_bytes = (manifest->>'totalSizeBytes')::NUMERIC
       AND actual_total_size_bytes <= maximum_total_size_bytes
       AND source_identity_digest = "prompt_refiner_sha256_json"(jsonb_build_object('files', files))
       AND manifest_digest = "prompt_refiner_sha256_json"(manifest);
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

CREATE UNIQUE INDEX "PromptRefinerReservationStage_authorizationAuditLogId_key"
    ON "PromptRefinerReservationStage"("authorizationAuditLogId");

ALTER TABLE "PromptRefinerReservationStage"
    ADD CONSTRAINT "PromptRefinerReservationStage_authorizationAuditLogId_fkey"
    FOREIGN KEY ("authorizationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "PromptRefinerReservationStage_admission_identity_check"
    CHECK (
        "admissionVersion" = 'prompt-refiner-stage-admission-v1'
        AND "proposalVersion" = 'prompt-refiner-shadow-stage-proposal-v1'
        AND "proposalDigest" = 'sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2'
        AND "evidenceBundleDigest" = 'sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159'
        AND "evidenceManifestSha256" = '9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d'
        AND "historicalSourceRef" = 'f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830'
        AND "historicalSourceIdentityDigest" = 'ac1813483dc62e44bb34fdc681be908611d72493567ba437322012a6e3438f39'
        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check"
    CHECK (
        "runtimeEnvironment" = 'staging'
        AND "runtimeCommitSha" ~ '^[a-f0-9]{40}$'
        AND "runtimeDeploymentId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "runtimeSourceIdentityDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND "runtimeSourceManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND "prompt_refiner_runtime_manifest_valid"(
            "runtimeSourceManifest",
            "runtimeCommitSha",
            "runtimeSourceIdentityDigest",
            "runtimeSourceManifestDigest"
        )
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check"
    CHECK (
        "executionManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND jsonb_typeof("executionManifest") = 'object'
        AND "executionManifestDigest" = "prompt_refiner_sha256_json"("executionManifest")
        AND "executionManifest" = '{
          "schemaVersion":"prompt-refiner-shadow-execution-manifest-v1",
          "stageId":"prompt-refiner-shadow-v1",
          "reservationContractDigest":"sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
          "runtimeSource":{"fileCount":186,"maxFileBytes":8388608,"maxTotalBytes":16777216},
          "executionContractVersion":"prompt-refiner-execution-contract-v1",
          "executionContract":{
            "contractVersion":"prompt-refiner-execution-contract-v1",
            "refinerVersion":"suggest-v1",
            "mode":"shadow",
            "userVisible":false,
            "model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},
            "request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},
            "stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}
          },
          "perRequestCostMicroUsd":24916,
          "maxReservations":100,
          "costCeilingMicroUsd":2491600,
          "executionAdmitted":false,
          "productAdapterReady":false
        }'::jsonb
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_approval_window_check"
    CHECK ("approvalExpiresAt" = "approvedAt" + INTERVAL '60 minutes');

DROP TRIGGER "prompt_refiner_stage_guard_trigger" ON "PromptRefinerReservationStage";
DROP FUNCTION "prompt_refiner_stage_guard"();

CREATE FUNCTION "prompt_refiner_stage_guard"()
RETURNS TRIGGER AS $$
DECLARE
    actual_count INTEGER;
    actual_cost BIGINT;
    observed_at TIMESTAMP(3);
    audit_actor TEXT;
    audit_action TEXT;
    audit_target_type TEXT;
    audit_target_id TEXT;
    audit_metadata JSONB;
    audit_entry_hash TEXT;
    audit_created_at TIMESTAMP(3);
    audit_observed_at TIMESTAMP(3);
    audit_approved_at TIMESTAMP(3);
    audit_expires_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0 THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage must start with zero accounting';
        END IF;
        audit_observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
        observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
        IF NEW."status" <> 'approved' THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage must start approved';
        END IF;
        SELECT "actorUserId", "action", "targetType", "targetId", "metadata", "entryHash", "createdAt"
        INTO audit_actor, audit_action, audit_target_type, audit_target_id,
             audit_metadata, audit_entry_hash, audit_created_at
        FROM "AdminAuditLog"
        WHERE "id" = NEW."authorizationAuditLogId";
        audit_approved_at := ((audit_metadata->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
        audit_expires_at := ((audit_metadata->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
        IF NOT FOUND
           OR audit_actor IS DISTINCT FROM NEW."approvedBy"
           OR audit_action IS DISTINCT FROM 'prompt_refiner.shadow_stage.activated'
           OR audit_target_type IS DISTINCT FROM 'PromptRefinerReservationStage'
           OR audit_target_id IS DISTINCT FROM 'prompt-refiner-shadow-v1'
           OR audit_entry_hash IS NULL
           OR audit_entry_hash !~ '^[a-f0-9]{64}$'
           OR audit_created_at < audit_observed_at - INTERVAL '1 minute'
           OR audit_created_at > audit_observed_at + INTERVAL '1 minute'
           OR audit_metadata IS DISTINCT FROM jsonb_build_object(
                'admissionVersion', NEW."admissionVersion",
                'proposalDigest', NEW."proposalDigest",
                'evidenceBundleDigest', NEW."evidenceBundleDigest",
                'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
                'executionManifestDigest', NEW."executionManifestDigest",
                'environment', NEW."runtimeEnvironment",
                'deploymentId', NEW."runtimeDeploymentId",
                'commitSha', NEW."runtimeCommitSha",
                'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
                'maxReservations', NEW."maxReservations",
                'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
                'approvalTtlMinutes', 60,
                'approvedAt', audit_metadata->'approvedAt',
                'approvalExpiresAt', audit_metadata->'approvalExpiresAt',
                'reason', 'bounded_staging_shadow_cost_approval'
           )
           OR jsonb_typeof(audit_metadata->'approvedAt') <> 'string'
           OR jsonb_typeof(audit_metadata->'approvalExpiresAt') <> 'string'
           OR audit_approved_at < observed_at - INTERVAL '1 minute'
           OR audit_approved_at > observed_at
           OR audit_expires_at <> audit_approved_at + INTERVAL '60 minutes'
           OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
           OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage authorization audit binding is invalid';
        END IF;
        NEW."approvedAt" := audit_approved_at;
        NEW."approvalExpiresAt" := audit_expires_at;
        NEW."createdAt" := observed_at;
        NEW."updatedAt" := observed_at;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
       OR NEW."maxReservations" IS DISTINCT FROM OLD."maxReservations"
       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
       OR NEW."admissionVersion" IS DISTINCT FROM OLD."admissionVersion"
       OR NEW."proposalVersion" IS DISTINCT FROM OLD."proposalVersion"
       OR NEW."proposalDigest" IS DISTINCT FROM OLD."proposalDigest"
       OR NEW."evidenceBundleDigest" IS DISTINCT FROM OLD."evidenceBundleDigest"
       OR NEW."evidenceManifestSha256" IS DISTINCT FROM OLD."evidenceManifestSha256"
       OR NEW."historicalSourceRef" IS DISTINCT FROM OLD."historicalSourceRef"
       OR NEW."historicalSourceIdentityDigest" IS DISTINCT FROM OLD."historicalSourceIdentityDigest"
       OR NEW."corpusDigest" IS DISTINCT FROM OLD."corpusDigest"
       OR NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha"
       OR NEW."runtimeSourceIdentityDigest" IS DISTINCT FROM OLD."runtimeSourceIdentityDigest"
       OR NEW."runtimeSourceManifest" IS DISTINCT FROM OLD."runtimeSourceManifest"
       OR NEW."runtimeSourceManifestDigest" IS DISTINCT FROM OLD."runtimeSourceManifestDigest"
       OR NEW."runtimeEnvironment" IS DISTINCT FROM OLD."runtimeEnvironment"
       OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
       OR NEW."executionManifest" IS DISTINCT FROM OLD."executionManifest"
       OR NEW."executionManifestDigest" IS DISTINCT FROM OLD."executionManifestDigest"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
       OR NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % contract is immutable', OLD."id";
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT (OLD."status" = 'approved' AND NEW."status" = 'closed') THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % status transition is invalid', OLD."id";
    END IF;
    IF NEW."reservationCount" = OLD."reservationCount"
       AND NEW."allocatedCostMicroUsd" = OLD."allocatedCostMicroUsd" THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
    INTO actual_count, actual_cost
    FROM "PromptRefinerReservation"
    WHERE "stageId" = OLD."id";
    IF NEW."reservationCount" <> actual_count
       OR NEW."allocatedCostMicroUsd" <> actual_cost THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % accounting must equal durable tombstones', OLD."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_stage_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerReservationStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_stage_guard"();

CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_insert_guard"()
RETURNS TRIGGER AS $$
DECLARE
    stage "PromptRefinerReservationStage"%ROWTYPE;
    observed_at TIMESTAMP(3);
BEGIN
    IF NEW."status" <> 'reserved'
       OR NEW."consumedAt" IS NOT NULL
       OR NEW."releasedAt" IS NOT NULL
       OR NEW."expiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerReservation must start reserved';
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NEW."stageId" <> 'prompt-refiner-shadow-v1'
       OR NEW."contractDigest" <> 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
       OR NEW."reservedCostMicroUsd" <> 24916
       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
       OR NEW."createdAt" > observed_at
       OR NEW."expiresAt" <= observed_at
       OR NEW."expiresAt" > observed_at + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'PromptRefinerReservation contract binding is invalid';
    END IF;

    SELECT * INTO stage
    FROM "PromptRefinerReservationStage"
    WHERE "id" = 'prompt-refiner-shadow-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
    END IF;
    IF stage."status" <> 'approved'
       OR stage."approvalExpiresAt" <= observed_at
       OR stage."runtimeEnvironment" <> 'staging'
       OR stage."contractVersion" <> 'prompt-refiner-execution-contract-v1'
       OR stage."contractDigest" <> NEW."contractDigest"
       OR stage."perRequestCostMicroUsd" <> 24916
       OR stage."maxReservations" <> 100
       OR stage."costCeilingMicroUsd" <> 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage contract is not approved';
    END IF;
    IF stage."reservationCount" >= 100
       OR stage."allocatedCostMicroUsd" + 24916 > 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    stage_expires_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerReservation % cannot be deleted', OLD."id";
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
       OR NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservation % binding is immutable', OLD."id";
    END IF;
    IF OLD."status" <> 'reserved' THEN
        RAISE EXCEPTION 'PromptRefinerReservation % is already terminal', OLD."id";
    END IF;
    IF NEW."consumedAt" IS NOT NULL
       OR NEW."releasedAt" IS NOT NULL
       OR NEW."expiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerReservation % terminal timestamp is database-owned', OLD."id";
    END IF;
    IF NEW."status" NOT IN ('consumed', 'released', 'expired') THEN
        RAISE EXCEPTION 'PromptRefinerReservation % transition is invalid', OLD."id";
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    SELECT "approvalExpiresAt" INTO stage_expires_at
    FROM "PromptRefinerReservationStage"
    WHERE "id" = OLD."stageId"
    FOR UPDATE;
    IF NEW."status" = 'consumed' AND (stage_expires_at IS NULL OR observed_at >= stage_expires_at) THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage approval expired before consume';
    END IF;
    IF NEW."status" = 'expired' AND observed_at < OLD."expiresAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservation % cannot expire before its deadline', OLD."id";
    END IF;
    IF observed_at >= OLD."expiresAt" THEN
        NEW."status" := 'expired';
        NEW."expiredAt" := observed_at;
    ELSIF NEW."status" = 'consumed' THEN
        NEW."consumedAt" := observed_at;
    ELSE
        NEW."releasedAt" := observed_at;
    END IF;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
