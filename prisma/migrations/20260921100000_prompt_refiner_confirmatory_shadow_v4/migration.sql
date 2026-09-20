-- Admit the reviewed Prompt Refiner confirmatory shadow v4 without mutating
-- the completed v1/v3 stage, reservations, run or attempts. No row is seeded,
-- no approval is inferred and no provider can be called by this migration.

ALTER FUNCTION "prompt_refiner_runtime_manifest_valid"(JSONB, TEXT, TEXT, TEXT)
    RENAME TO "prompt_refiner_runtime_manifest_v2_valid";

-- v3 is the v2 closure plus this migration at the exact reviewed position.
-- The original validator remains the authority for all 187 legacy paths; this
-- wrapper validates the one-file extension and both full-manifest digests.
CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"(
    manifest JSONB,
    commit_sha TEXT,
    source_identity_digest TEXT,
    manifest_digest TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    files JSONB;
    added JSONB;
    legacy_files JSONB;
    legacy_manifest JSONB;
BEGIN
    IF manifest->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2' THEN
        RETURN "prompt_refiner_runtime_manifest_v2_valid"(
            manifest, commit_sha, source_identity_digest, manifest_digest
        );
    END IF;
    IF manifest->>'schemaVersion' <> 'prompt-refiner-runtime-source-manifest-v3'
       OR jsonb_typeof(manifest) <> 'object'
       OR manifest <> jsonb_build_object(
            'schemaVersion', manifest->'schemaVersion',
            'commitSha', manifest->'commitSha',
            'totalSizeBytes', manifest->'totalSizeBytes',
            'files', manifest->'files'
       )
       OR manifest->>'commitSha' <> commit_sha
       OR commit_sha !~ '^[a-f0-9]{40}$'
       OR jsonb_typeof(manifest->'files') <> 'array'
       OR jsonb_array_length(manifest->'files') <> 188
       OR jsonb_typeof(manifest->'totalSizeBytes') <> 'number'
       OR manifest->>'totalSizeBytes' !~ '^[1-9][0-9]*$'
       OR (manifest->>'totalSizeBytes')::NUMERIC > 16777216
       OR source_identity_digest <> "prompt_refiner_sha256_json"(
            jsonb_build_object('files', manifest->'files')
       )
       OR manifest_digest <> "prompt_refiner_sha256_json"(manifest) THEN
        RETURN FALSE;
    END IF;
    files := manifest->'files';
    added := files->6;
    IF added <> jsonb_build_object(
            'path', 'prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql',
            'sizeBytes', added->'sizeBytes',
            'sha256', added->'sha256'
       )
       OR jsonb_typeof(added->'sizeBytes') <> 'number'
       OR added->>'sizeBytes' !~ '^[1-9][0-9]*$'
       OR (added->>'sizeBytes')::NUMERIC > 8388608
       OR jsonb_typeof(added->'sha256') <> 'string'
       OR added->>'sha256' !~ '^[a-f0-9]{64}$' THEN
        RETURN FALSE;
    END IF;
    SELECT jsonb_agg(value ORDER BY ordinal)
    INTO legacy_files
    FROM jsonb_array_elements(files) WITH ORDINALITY AS entry(value, ordinal)
    WHERE ordinal <> 7;
    legacy_manifest := jsonb_build_object(
        'schemaVersion', 'prompt-refiner-runtime-source-manifest-v2',
        'commitSha', commit_sha,
        'totalSizeBytes',
            (manifest->>'totalSizeBytes')::NUMERIC - (added->>'sizeBytes')::NUMERIC,
        'files', legacy_files
    );
    RETURN "prompt_refiner_runtime_manifest_v2_valid"(
        legacy_manifest,
        commit_sha,
        "prompt_refiner_sha256_json"(jsonb_build_object('files', legacy_files)),
        "prompt_refiner_sha256_json"(legacy_manifest)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

ALTER TABLE "PromptRefinerReservationStage"
    DROP CONSTRAINT "PromptRefinerReservationStage_id_check",
    DROP CONSTRAINT "PromptRefinerReservationStage_contract_check",
    DROP CONSTRAINT "PromptRefinerReservationStage_admission_identity_check",
    DROP CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check",
    DROP CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check";

ALTER TABLE "PromptRefinerReservationStage"
    ADD CONSTRAINT "PromptRefinerReservationStage_id_check" CHECK (
        "id" IN ('prompt-refiner-shadow-v1', 'prompt-refiner-shadow-v2')
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_contract_check" CHECK (
        "contractVersion" = 'prompt-refiner-execution-contract-v1'
        AND (
            ("id" = 'prompt-refiner-shadow-v1'
             AND "contractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f')
            OR
            ("id" = 'prompt-refiner-shadow-v2'
             AND "contractDigest" = 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1')
        )
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_admission_identity_check" CHECK (
        "proposalVersion" = 'prompt-refiner-shadow-stage-proposal-v1'
        AND "proposalDigest" = 'sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2'
        AND "evidenceBundleDigest" = 'sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159'
        AND "evidenceManifestSha256" = '9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d'
        AND "historicalSourceRef" = 'f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830'
        AND "historicalSourceIdentityDigest" = 'ac1813483dc62e44bb34fdc681be908611d72493567ba437322012a6e3438f39'
        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
        AND (
            ("id" = 'prompt-refiner-shadow-v1'
             AND "admissionVersion" = 'prompt-refiner-stage-admission-v1')
            OR
            ("id" = 'prompt-refiner-shadow-v2'
             AND "admissionVersion" = 'prompt-refiner-stage-admission-v2')
        )
    ),
    -- PostgreSQL constraints bind to a function object, not a function name.
    -- Recreate this CHECK after renaming the legacy validator so v1 rows keep
    -- using the wrapper's v2 branch and new v2 rows may use manifest v3.
    ADD CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check" CHECK (
        "runtimeEnvironment" = 'staging'
        AND "runtimeCommitSha" ~ '^[a-f0-9]{40}$'
        AND "runtimeDeploymentId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "runtimeSourceIdentityDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND "runtimeSourceManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND (
            ("id" = 'prompt-refiner-shadow-v1'
             AND "runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v2')
            OR
            ("id" = 'prompt-refiner-shadow-v2'
             AND "runtimeSourceManifest"->>'schemaVersion' = 'prompt-refiner-runtime-source-manifest-v3')
        )
        AND "prompt_refiner_runtime_manifest_valid"(
            "runtimeSourceManifest",
            "runtimeCommitSha",
            "runtimeSourceIdentityDigest",
            "runtimeSourceManifestDigest"
        )
    ),
    ADD CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check" CHECK (
        "executionManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND jsonb_typeof("executionManifest") = 'object'
        AND "executionManifestDigest" = "prompt_refiner_sha256_json"("executionManifest")
        AND (
            ("id" = 'prompt-refiner-shadow-v1' AND "executionManifest" = '{
              "schemaVersion":"prompt-refiner-shadow-execution-manifest-v1",
              "stageId":"prompt-refiner-shadow-v1",
              "reservationContractDigest":"sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
              "runtimeSource":{"fileCount":187,"maxFileBytes":8388608,"maxTotalBytes":16777216},
              "executionContractVersion":"prompt-refiner-execution-contract-v1",
              "executionContract":{"contractVersion":"prompt-refiner-execution-contract-v1","refinerVersion":"suggest-v1","mode":"shadow","userVisible":false,"model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},"request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},"stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}},
              "perRequestCostMicroUsd":24916,"maxReservations":100,"costCeilingMicroUsd":2491600,"executionAdmitted":false,"productAdapterReady":false
            }'::jsonb)
            OR
            ("id" = 'prompt-refiner-shadow-v2' AND "executionManifest" = '{
              "schemaVersion":"prompt-refiner-shadow-execution-manifest-v2",
              "stageId":"prompt-refiner-shadow-v2",
              "reservationContractDigest":"sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1",
              "runtimeSource":{"fileCount":188,"maxFileBytes":8388608,"maxTotalBytes":16777216},
              "executionContractVersion":"prompt-refiner-execution-contract-v1",
              "executionContract":{"contractVersion":"prompt-refiner-execution-contract-v1","refinerVersion":"suggest-v1","mode":"shadow","userVisible":false,"model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},"request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},"stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}},
              "perRequestCostMicroUsd":24916,"maxReservations":100,"costCeilingMicroUsd":2491600,"executionAdmitted":false,"productAdapterReady":false
            }'::jsonb)
        )
    );

CREATE OR REPLACE FUNCTION "prompt_refiner_stage_guard"()
RETURNS TRIGGER AS $$
DECLARE
    actual_count INTEGER;
    actual_cost BIGINT;
    observed_at TIMESTAMP(3);
    audit "AdminAuditLog"%ROWTYPE;
    audit_approved_at TIMESTAMP(3);
    audit_expires_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
    END IF;
    IF TG_OP = 'INSERT' THEN
        observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
        IF NEW."id" <> 'prompt-refiner-shadow-v2'
           OR NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0
           OR NEW."status" <> 'approved' THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage v2 must start with zero accounting and approved status';
        END IF;
        SELECT * INTO audit FROM "AdminAuditLog"
        WHERE "id" = NEW."authorizationAuditLogId";
        audit_approved_at := ((audit."metadata"->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
        audit_expires_at := ((audit."metadata"->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
        IF NOT FOUND OR audit."actorUserId" IS DISTINCT FROM NEW."approvedBy"
           OR audit."action" <> 'prompt_refiner.shadow_stage.activated'
           OR audit."targetType" <> 'PromptRefinerReservationStage'
           OR audit."targetId" IS DISTINCT FROM NEW."id"
           OR audit."entryHash" IS NULL OR audit."entryHash" !~ '^[a-f0-9]{64}$'
           OR audit."createdAt" < observed_at - INTERVAL '1 minute'
           OR audit."createdAt" > observed_at + INTERVAL '1 minute'
           OR audit."metadata" IS DISTINCT FROM jsonb_build_object(
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
                'approvedAt', audit."metadata"->'approvedAt',
                'approvalExpiresAt', audit."metadata"->'approvalExpiresAt',
                'reason', 'bounded_staging_shadow_cost_approval'
           )
           OR jsonb_typeof(audit."metadata"->'approvedAt') <> 'string'
           OR jsonb_typeof(audit."metadata"->'approvalExpiresAt') <> 'string'
           OR audit_approved_at < observed_at - INTERVAL '1 minute'
           OR audit_approved_at > observed_at
           OR audit_expires_at <> audit_approved_at + INTERVAL '60 minutes'
           OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
           OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage authorization audit binding is invalid';
        END IF;
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
    INTO actual_count, actual_cost FROM "PromptRefinerReservation"
    WHERE "stageId" = OLD."id";
    IF NEW."reservationCount" <> actual_count
       OR NEW."allocatedCostMicroUsd" <> actual_cost THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage % accounting must equal durable tombstones', OLD."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_insert_guard"()
RETURNS TRIGGER AS $$
DECLARE
    stage "PromptRefinerReservationStage"%ROWTYPE;
    observed_at TIMESTAMP(3);
BEGIN
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NEW."status" <> 'reserved' OR NEW."consumedAt" IS NOT NULL
       OR NEW."releasedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL
       OR NEW."stageId" <> 'prompt-refiner-shadow-v2'
       OR NEW."contractDigest" <> 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
       OR NEW."reservedCostMicroUsd" <> 24916
       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
       OR NEW."createdAt" > observed_at OR NEW."expiresAt" <= observed_at
       OR NEW."expiresAt" > observed_at + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'PromptRefinerReservation v2 contract binding is invalid';
    END IF;
    SELECT * INTO stage FROM "PromptRefinerReservationStage"
    WHERE "id" = NEW."stageId" FOR UPDATE;
    IF NOT FOUND OR stage."status" <> 'approved'
       OR stage."approvalExpiresAt" <= observed_at
       OR stage."runtimeEnvironment" <> 'staging'
       OR stage."contractVersion" <> 'prompt-refiner-execution-contract-v1'
       OR stage."contractDigest" <> NEW."contractDigest"
       OR stage."perRequestCostMicroUsd" <> 24916
       OR stage."maxReservations" <> 100
       OR stage."costCeilingMicroUsd" <> 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage v2 contract is not approved';
    END IF;
    IF stage."reservationCount" >= 100
       OR stage."allocatedCostMicroUsd" + 24916 > 2491600 THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_account_insert"()
RETURNS TRIGGER AS $$
DECLARE
    affected_stage TEXT;
    actual_count INTEGER;
    actual_cost BIGINT;
    changed INTEGER;
BEGIN
    FOR affected_stage IN
        SELECT DISTINCT "stageId" FROM inserted_reservations
    LOOP
        SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
        INTO actual_count, actual_cost FROM "PromptRefinerReservation"
        WHERE "stageId" = affected_stage;
        IF actual_count > 100 OR actual_cost > 2491600 THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
        END IF;
        UPDATE "PromptRefinerReservationStage"
        SET "reservationCount" = actual_count,
            "allocatedCostMicroUsd" = actual_cost,
            "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = affected_stage;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed <> 1 THEN
            RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "PromptRefinerShadowRun"
    ADD COLUMN "evidenceSpecDigest" TEXT;
ALTER TABLE "PromptRefinerShadowAttempt"
    ADD COLUMN "evidence" JSONB;

ALTER TABLE "PromptRefinerShadowRun"
    DROP CONSTRAINT "PromptRefinerShadowRun_contract_check";
ALTER TABLE "PromptRefinerShadowRun"
    ADD CONSTRAINT "PromptRefinerShadowRun_contract_check" CHECK (
        "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
        AND "perRequestCostMicroUsd" = 24916
        AND "maxDispatches" = 16
        AND "costCeilingMicroUsd" = 398656
        AND (
            ("stageId" = 'prompt-refiner-shadow-v1'
             AND "runContractVersion" = 'prompt-refiner-shadow-run-v3'
             AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
             AND "evidenceSpecDigest" IS NULL)
            OR
            ("stageId" = 'prompt-refiner-shadow-v2'
             AND "runContractVersion" = 'prompt-refiner-shadow-run-v4'
             AND "runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
             AND "evidenceSpecDigest" = '7794b9fbbd8fba1f16d19f935a977098f3f7a8d302014d6e7de3fe00813ae4c1')
        )
    );

ALTER TABLE "PromptRefinerShadowAttempt"
    DROP CONSTRAINT "PromptRefinerShadowAttempt_binding_check",
    DROP CONSTRAINT "PromptRefinerShadowAttempt_terminal_check";
ALTER TABLE "PromptRefinerShadowAttempt"
    ADD CONSTRAINT "PromptRefinerShadowAttempt_v4_duration_check" CHECK (
        "runContractDigest" <> 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
        OR "durationMs" IS NULL
        OR "durationMs" <= 60000
    ),
    ADD CONSTRAINT "PromptRefinerShadowAttempt_binding_check" CHECK (
        "id" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "runId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "reservationId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "requestId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "caseId" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "caseIndex" BETWEEN 0 AND 15
        AND "provider" = 'openai' AND "modelId" = 'gpt-5-6-luna'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
        AND (
            ("stageId" = 'prompt-refiner-shadow-v1'
             AND "reservationContractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
             AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280')
            OR
            ("stageId" = 'prompt-refiner-shadow-v2'
             AND "reservationContractDigest" = 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
             AND "runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7')
        )
    ),
    ADD CONSTRAINT "PromptRefinerShadowAttempt_terminal_check" CHECK (
        ("status" = 'dispatch_intent'
         AND "terminalReason" IS NULL AND "failureLayer" IS NULL
         AND "failureCode" IS NULL AND "terminalAt" IS NULL
         AND "durationMs" IS NULL AND "inputTokens" IS NULL
         AND "cachedInputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL
         AND "outputTokens" IS NULL AND "reasoningTokens" IS NULL
         AND "actualCostMicroUsd" IS NULL AND "terminalAuditLogId" IS NULL
         AND "evidence" IS NULL)
        OR
        ("status" = 'terminal'
         AND "terminalReason" IN ('suggested','provider_error','timeout','invalid_response','empty_response','no_change','cancelled_after_dispatch','unknown_after_dispatch')
         AND "terminalAt" IS NOT NULL AND "terminalAuditLogId" IS NOT NULL
         AND (
            ("terminalReason" = 'suggested' AND "failureLayer" = 'none' AND "failureCode" IS NULL)
            OR ("terminalReason" IN ('provider_error','timeout','cancelled_after_dispatch','unknown_after_dispatch')
                AND "failureLayer" = 'provider' AND "failureCode" IS NOT NULL)
            OR ("terminalReason" IN ('invalid_response','empty_response','no_change')
                AND "failureLayer" = 'response_validation' AND "failureCode" = "terminalReason")
         )
         AND (
            ("runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
             AND "evidence" IS NULL)
            OR
            ("runContractDigest" = 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
             AND jsonb_typeof("evidence") = 'object'
             AND "evidence"->>'caseId' = "caseId"
             AND "evidence"->>'terminalStatus' = CASE
                    WHEN "terminalReason" = 'suggested' THEN 'suggested'
                    WHEN "terminalReason" = 'unknown_after_dispatch' THEN 'unknown'
                    ELSE 'failed' END
             AND "evidence" = jsonb_build_object(
                    'caseId', "evidence"->'caseId',
                    'language', "evidence"->'language',
                    'category', "evidence"->'category',
                    'terminalStatus', "evidence"->'terminalStatus',
                    'evidenceStatus', "evidence"->'evidenceStatus',
                    'distinctFromSource', "evidence"->'distinctFromSource',
                    'lengthWithinBounds', "evidence"->'lengthWithinBounds',
                    'languageMatched', "evidence"->'languageMatched',
                    'requiredConceptGroups', "evidence"->'requiredConceptGroups',
                    'matchedConceptGroups', "evidence"->'matchedConceptGroups',
                    'requiredExactLiterals', "evidence"->'requiredExactLiterals',
                    'preservedExactLiterals', "evidence"->'preservedExactLiterals',
                    'injectionSafelyFramed', "evidence"->'injectionSafelyFramed',
                    'lengthBucket', "evidence"->'lengthBucket',
                    'failureReasons', "evidence"->'failureReasons'
             ))
         )
        )
    );

CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_run_insert_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    stage "PromptRefinerReservationStage"%ROWTYPE;
    audit "AdminAuditLog"%ROWTYPE;
    audit_approved_at TIMESTAMP(3);
    audit_expires_at TIMESTAMP(3);
BEGIN
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NEW."stageId" <> 'prompt-refiner-shadow-v2'
       OR NEW."runContractVersion" <> 'prompt-refiner-shadow-run-v4'
       OR NEW."status" <> 'approved' OR NEW."dispatchCount" <> 0
       OR NEW."terminalCount" <> 0 OR NEW."knownActualCostMicroUsd" <> 0
       OR NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
       OR NEW."stoppedAt" IS NOT NULL OR NEW."stopReason" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun v4 must start approved and empty';
    END IF;
    IF NEW."approvedAt" > observed_at OR NEW."approvalExpiresAt" <= observed_at
       OR NEW."createdAt" < NEW."approvedAt"
       OR NEW."createdAt" > observed_at + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun approval time is invalid';
    END IF;
    SELECT * INTO stage FROM "PromptRefinerReservationStage"
    WHERE "id" = NEW."stageId" FOR UPDATE;
    IF NOT FOUND OR stage."status" <> 'approved'
       OR stage."approvalExpiresAt" <= observed_at
       OR NEW."approvalExpiresAt" > stage."approvalExpiresAt"
       OR stage."contractDigest" <> 'sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1'
       OR stage."corpusDigest" <> NEW."corpusDigest"
       OR stage."runtimeCommitSha" <> NEW."runtimeCommitSha"
       OR stage."runtimeDeploymentId" <> NEW."runtimeDeploymentId" THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun stage binding is invalid';
    END IF;
    SELECT * INTO audit FROM "AdminAuditLog"
    WHERE "id" = NEW."authorizationAuditLogId";
    audit_approved_at := ((audit."metadata"->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
    audit_expires_at := ((audit."metadata"->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NOT FOUND OR audit."actorUserId" IS DISTINCT FROM NEW."approvedBy"
       OR audit."action" <> 'prompt_refiner.shadow_run.approved'
       OR audit."targetType" <> 'PromptRefinerShadowRun'
       OR audit."targetId" IS DISTINCT FROM NEW."id"
       OR audit."summary" <> 'Approved one bounded Prompt Refiner staging shadow run.'
       OR audit."entryHash" IS NULL OR audit."entryHash" !~ '^[a-f0-9]{64}$'
       OR audit."metadata" IS DISTINCT FROM jsonb_build_object(
            'stageId', NEW."stageId",
            'runContractVersion', NEW."runContractVersion",
            'runContractDigest', NEW."runContractDigest",
            'corpusDigest', NEW."corpusDigest",
            'evidenceSpecDigest', NEW."evidenceSpecDigest",
            'adapterVersion', NEW."adapterVersion",
            'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
            'previewBindingDigest', NEW."previewBindingDigest",
            'runtimeDeploymentId', NEW."runtimeDeploymentId",
            'runtimeCommitSha', NEW."runtimeCommitSha",
            'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
            'maxDispatches', NEW."maxDispatches",
            'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
            'timeoutMs', 15000, 'retryCount', 0,
            'unknownOutcomePolicy', 'stop_no_redispatch',
            'approvedAt', audit."metadata"->'approvedAt',
            'approvalExpiresAt', audit."metadata"->'approvalExpiresAt',
            'executionAdmitted', true, 'productAdapterReady', false
       )
       OR jsonb_typeof(audit."metadata"->'approvedAt') <> 'string'
       OR jsonb_typeof(audit."metadata"->'approvalExpiresAt') <> 'string'
       OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
       OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun authorization audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_run_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    actual_dispatches INTEGER;
    actual_terminals INTEGER;
    actual_cost BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % cannot be deleted', OLD."id";
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
       OR NEW."runContractVersion" IS DISTINCT FROM OLD."runContractVersion"
       OR NEW."runContractDigest" IS DISTINCT FROM OLD."runContractDigest"
       OR NEW."corpusDigest" IS DISTINCT FROM OLD."corpusDigest"
       OR NEW."evidenceSpecDigest" IS DISTINCT FROM OLD."evidenceSpecDigest"
       OR NEW."adapterVersion" IS DISTINCT FROM OLD."adapterVersion"
       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
       OR NEW."maxDispatches" IS DISTINCT FROM OLD."maxDispatches"
       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
       OR NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha"
       OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
       OR NEW."runtimeSourceManifest" IS DISTINCT FROM OLD."runtimeSourceManifest"
       OR NEW."runtimeSourceManifestDigest" IS DISTINCT FROM OLD."runtimeSourceManifestDigest"
       OR NEW."previewBindingDigest" IS DISTINCT FROM OLD."previewBindingDigest"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
       OR NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % binding is immutable', OLD."id";
    END IF;
    IF OLD."status" = 'completed' THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % is terminal', OLD."id";
    END IF;
    IF OLD."status" = 'stopped_unknown' AND NEW."status" <> 'stopped_unknown' THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % unknown latch is immutable', OLD."id";
    END IF;
    IF NOT ((NEW."status" = OLD."status")
       OR (OLD."status" = 'approved' AND NEW."status" = 'running')
       OR (OLD."status" = 'running' AND NEW."status" IN ('completed','stopped_unknown'))) THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % transition is invalid', OLD."id";
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
       OR NEW."stoppedAt" IS DISTINCT FROM OLD."stoppedAt"
       OR NEW."stopReason" IS DISTINCT FROM OLD."stopReason" THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % timestamps are database-owned', OLD."id";
    END IF;
    IF OLD."status" = 'approved' AND NEW."status" = 'running' THEN
        NEW."startedAt" := observed_at;
    ELSIF NEW."status" = 'completed' THEN
        NEW."completedAt" := observed_at;
    ELSIF OLD."status" <> 'stopped_unknown' AND NEW."status" = 'stopped_unknown' THEN
        NEW."stoppedAt" := observed_at;
        NEW."stopReason" := 'unknown_after_dispatch';
    END IF;
    SELECT COUNT(*)::INTEGER,
           COUNT(*) FILTER (WHERE "status" = 'terminal')::INTEGER,
           COALESCE(SUM("actualCostMicroUsd") FILTER (WHERE "status" = 'terminal'), 0)::BIGINT
    INTO actual_dispatches, actual_terminals, actual_cost
    FROM "PromptRefinerShadowAttempt" WHERE "runId" = OLD."id";
    IF NEW."dispatchCount" <> actual_dispatches
       OR NEW."terminalCount" <> actual_terminals
       OR NEW."knownActualCostMicroUsd" <> actual_cost THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun % accounting must equal attempts', OLD."id";
    END IF;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_attempt_insert_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    run "PromptRefinerShadowRun"%ROWTYPE;
    reservation "PromptRefinerReservation"%ROWTYPE;
    audit "AdminAuditLog"%ROWTYPE;
    admission_tokens INTEGER;
BEGIN
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF NEW."runContractDigest" <> 'sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7'
       OR NEW."status" <> 'dispatch_intent' OR NEW."evidence" IS NOT NULL
       OR NEW."dispatchIntentAt" <> NEW."createdAt"
       OR NEW."dispatchIntentAt" > observed_at
       OR NEW."dispatchIntentAt" < observed_at - INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt v4 must start as a current dispatch intent';
    END IF;
    SELECT * INTO run FROM "PromptRefinerShadowRun"
    WHERE "id" = NEW."runId" FOR UPDATE;
    IF NOT FOUND OR run."status" NOT IN ('approved','running')
       OR run."approvalExpiresAt" <= observed_at
       OR run."runContractDigest" <> NEW."runContractDigest"
       OR run."stageId" <> NEW."stageId"
       OR run."adapterVersion" <> NEW."adapterVersion"
       OR run."dispatchCount" >= run."maxDispatches"
       OR run."knownActualCostMicroUsd" > run."costCeilingMicroUsd" THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun cannot accept a dispatch intent';
    END IF;
    SELECT * INTO reservation FROM "PromptRefinerReservation"
    WHERE "id" = NEW."reservationId" FOR UPDATE;
    IF NOT FOUND OR reservation."status" <> 'reserved'
       OR reservation."expiresAt" <= observed_at
       OR reservation."requestId" <> NEW."requestId"
       OR reservation."stageId" <> NEW."stageId"
       OR reservation."contractDigest" <> NEW."reservationContractDigest" THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt reservation binding is invalid';
    END IF;
    SELECT * INTO audit FROM "AdminAuditLog" WHERE "id" = NEW."dispatchAuditLogId";
    IF jsonb_typeof(audit."metadata"->'admissionInputTokens') = 'number' THEN
        admission_tokens := (audit."metadata"->>'admissionInputTokens')::INTEGER;
    END IF;
    IF NOT FOUND OR audit."actorUserId" IS NOT NULL
       OR audit."action" <> 'prompt_refiner.shadow_dispatch.intent_recorded'
       OR audit."targetType" <> 'PromptRefinerShadowAttempt'
       OR audit."targetId" IS DISTINCT FROM NEW."id"
       OR audit."summary" <> 'Recorded one Prompt Refiner provider dispatch intent.'
       OR audit."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-shadow-runner'
       OR audit."metadata"->>'runId' IS DISTINCT FROM NEW."runId"
       OR audit."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"
       OR audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"
       OR audit."metadata"->>'caseId' IS DISTINCT FROM NEW."caseId"
       OR (audit."metadata"->>'caseIndex')::INTEGER IS DISTINCT FROM NEW."caseIndex"
       OR audit."metadata"->>'runContractDigest' IS DISTINCT FROM NEW."runContractDigest"
       OR audit."metadata"->>'adapterVersion' IS DISTINCT FROM NEW."adapterVersion"
       OR audit."metadata"->>'provider' IS DISTINCT FROM NEW."provider"
       OR audit."metadata"->>'modelId' IS DISTINCT FROM NEW."modelId"
       OR (audit."metadata"->>'timeoutMs')::INTEGER IS DISTINCT FROM 15000
       OR (audit."metadata"->>'retryCount')::INTEGER IS DISTINCT FROM 0
       OR audit."metadata"->>'tokenizerPackage' IS DISTINCT FROM 'js-tiktoken'
       OR audit."metadata"->>'tokenizerPackageVersion' IS DISTINCT FROM '1.0.21'
       OR audit."metadata"->>'tokenizerEncoding' IS DISTINCT FROM 'o200k_base'
       OR admission_tokens IS NULL OR admission_tokens < 0 OR admission_tokens > 100000 THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt dispatch audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "prompt_refiner_shadow_attempt_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    audit "AdminAuditLog"%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt % cannot be deleted', OLD."id";
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."runId" IS DISTINCT FROM OLD."runId"
       OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
       OR NEW."caseId" IS DISTINCT FROM OLD."caseId"
       OR NEW."caseIndex" IS DISTINCT FROM OLD."caseIndex"
       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
       OR NEW."reservationContractDigest" IS DISTINCT FROM OLD."reservationContractDigest"
       OR NEW."runContractDigest" IS DISTINCT FROM OLD."runContractDigest"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."modelId" IS DISTINCT FROM OLD."modelId"
       OR NEW."adapterVersion" IS DISTINCT FROM OLD."adapterVersion"
       OR NEW."dispatchIntentAt" IS DISTINCT FROM OLD."dispatchIntentAt"
       OR NEW."dispatchAuditLogId" IS DISTINCT FROM OLD."dispatchAuditLogId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt % binding is immutable', OLD."id";
    END IF;
    IF OLD."status" <> 'dispatch_intent' OR NEW."status" <> 'terminal' THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt % terminal is immutable', OLD."id";
    END IF;
    IF NEW."terminalAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt % terminal timestamp is database-owned', OLD."id";
    END IF;
    SELECT * INTO audit FROM "AdminAuditLog" WHERE "id" = NEW."terminalAuditLogId";
    IF NOT FOUND OR audit."actorUserId" IS NOT NULL
       OR audit."action" <> 'prompt_refiner.shadow_dispatch.terminal_recorded'
       OR audit."targetType" <> 'PromptRefinerShadowAttempt'
       OR audit."targetId" IS DISTINCT FROM NEW."id"
       OR audit."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-shadow-runner'
       OR audit."metadata"->>'runId' IS DISTINCT FROM NEW."runId"
       OR audit."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"
       OR audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"
       OR audit."metadata"->>'terminalReason' IS DISTINCT FROM NEW."terminalReason"
       OR audit."metadata"->'evidence' IS DISTINCT FROM NEW."evidence" THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt terminal audit binding is invalid';
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    NEW."terminalAt" := observed_at;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
