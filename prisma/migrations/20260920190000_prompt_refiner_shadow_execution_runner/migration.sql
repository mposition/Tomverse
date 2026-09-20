-- Admit only the reviewed v3 Prompt Refiner shadow execution contract.
-- No approval, reservation, attempt or provider request is created here.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "PromptRefinerShadowRun")
       OR EXISTS (SELECT 1 FROM "PromptRefinerShadowAttempt") THEN
        RAISE EXCEPTION 'Prompt Refiner v3 migration requires empty shadow run tables';
    END IF;
END;
$$;

ALTER TABLE "PromptRefinerShadowRun"
    DROP CONSTRAINT "PromptRefinerShadowRun_contract_check";
ALTER TABLE "PromptRefinerShadowRun"
    ADD CONSTRAINT "PromptRefinerShadowRun_contract_check" CHECK (
        "stageId" = 'prompt-refiner-shadow-v1'
        AND "runContractVersion" = 'prompt-refiner-shadow-run-v3'
        AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
        AND "perRequestCostMicroUsd" = 24916
        AND "maxDispatches" = 16
        AND "costCeilingMicroUsd" = 398656
    );

ALTER TABLE "PromptRefinerShadowAttempt"
    DROP CONSTRAINT "PromptRefinerShadowAttempt_binding_check";
ALTER TABLE "PromptRefinerShadowAttempt"
    ADD CONSTRAINT "PromptRefinerShadowAttempt_binding_check" CHECK (
        "id" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "runId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "reservationId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "requestId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "caseId" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "caseIndex" BETWEEN 0 AND 15
        AND "stageId" = 'prompt-refiner-shadow-v1'
        AND "reservationContractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
        AND "runContractDigest" = 'sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280'
        AND "provider" = 'openai'
        AND "modelId" = 'gpt-5-6-luna'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
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
    IF NEW."status" <> 'approved' OR NEW."dispatchCount" <> 0
       OR NEW."terminalCount" <> 0 OR NEW."knownActualCostMicroUsd" <> 0
       OR NEW."startedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
       OR NEW."stoppedAt" IS NOT NULL OR NEW."stopReason" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun must start approved and empty';
    END IF;
    IF NEW."approvedAt" > observed_at
       OR NEW."approvalExpiresAt" <= observed_at
       OR NEW."createdAt" < NEW."approvedAt"
       OR NEW."createdAt" > observed_at + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'PromptRefinerShadowRun approval time is invalid';
    END IF;
    SELECT * INTO stage FROM "PromptRefinerReservationStage"
    WHERE "id" = NEW."stageId" FOR UPDATE;
    IF NOT FOUND OR stage."status" <> 'approved'
       OR stage."approvalExpiresAt" <= observed_at
       OR NEW."approvalExpiresAt" > stage."approvalExpiresAt"
       OR stage."contractDigest" <> 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
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
            'adapterVersion', NEW."adapterVersion",
            'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
            'previewBindingDigest', NEW."previewBindingDigest",
            'runtimeDeploymentId', NEW."runtimeDeploymentId",
            'runtimeCommitSha', NEW."runtimeCommitSha",
            'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
            'maxDispatches', NEW."maxDispatches",
            'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
            'timeoutMs', 15000,
            'retryCount', 0,
            'unknownOutcomePolicy', 'stop_no_redispatch',
            'approvedAt', audit."metadata"->'approvedAt',
            'approvalExpiresAt', audit."metadata"->'approvalExpiresAt',
            'executionAdmitted', true,
            'productAdapterReady', false
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
    IF NEW."status" <> 'dispatch_intent' OR NEW."dispatchIntentAt" <> NEW."createdAt"
       OR NEW."dispatchIntentAt" > observed_at
       OR NEW."dispatchIntentAt" < observed_at - INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt must start as a current dispatch intent';
    END IF;
    SELECT * INTO run FROM "PromptRefinerShadowRun" WHERE "id" = NEW."runId" FOR UPDATE;
    IF NOT FOUND OR run."status" NOT IN ('approved', 'running')
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
