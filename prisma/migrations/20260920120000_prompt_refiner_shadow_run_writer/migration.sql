-- Durable, content-free Prompt Refiner shadow run and terminal receipts.
-- No row is seeded. The owner-only application writer must first create the
-- exact run authorization; no migration or trigger can call a provider.

CREATE TABLE "PromptRefinerShadowRun" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "runContractVersion" TEXT NOT NULL,
    "runContractDigest" TEXT NOT NULL,
    "corpusDigest" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "perRequestCostMicroUsd" BIGINT NOT NULL,
    "maxDispatches" INTEGER NOT NULL,
    "costCeilingMicroUsd" BIGINT NOT NULL,
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "terminalCount" INTEGER NOT NULL DEFAULT 0,
    "knownActualCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "runtimeCommitSha" TEXT NOT NULL,
    "runtimeDeploymentId" TEXT NOT NULL,
    "runtimeSourceManifest" JSONB NOT NULL,
    "runtimeSourceManifestDigest" TEXT NOT NULL,
    "previewBindingDigest" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "approvalExpiresAt" TIMESTAMP(3) NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PromptRefinerShadowRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerShadowRun_status_check"
        CHECK ("status" IN ('approved', 'running', 'completed', 'stopped_unknown')),
    CONSTRAINT "PromptRefinerShadowRun_contract_check" CHECK (
        "stageId" = 'prompt-refiner-shadow-v1'
        AND "runContractVersion" = 'prompt-refiner-shadow-run-v2'
        AND "runContractDigest" = 'sha256:a48ca37275c72f5a39d6029c9952d0ab4e35de7e55a4fd7086cb8a148eb6222a'
        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
        AND "perRequestCostMicroUsd" = 24916
        AND "maxDispatches" = 16
        AND "costCeilingMicroUsd" = 398656
    ),
    CONSTRAINT "PromptRefinerShadowRun_accounting_check" CHECK (
        "dispatchCount" >= 0
        AND "dispatchCount" <= "maxDispatches"
        AND "terminalCount" >= 0
        AND "terminalCount" <= "dispatchCount"
        AND "knownActualCostMicroUsd" >= 0
        AND "knownActualCostMicroUsd" <= "costCeilingMicroUsd"
    ),
    CONSTRAINT "PromptRefinerShadowRun_identity_check" CHECK (
        "id" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "runtimeCommitSha" ~ '^[a-f0-9]{40}$'
        AND "runtimeDeploymentId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "runtimeSourceManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND "previewBindingDigest" ~ '^sha256:[a-f0-9]{64}$'
        AND length("approvedBy") BETWEEN 1 AND 128
    ),
    CONSTRAINT "PromptRefinerShadowRun_time_check" CHECK (
        "approvedAt" < "approvalExpiresAt"
        AND "createdAt" >= "approvedAt"
        AND "createdAt" < "approvalExpiresAt"
    ),
    CONSTRAINT "PromptRefinerShadowRun_terminal_shape_check" CHECK (
        ("status" = 'approved' AND "dispatchCount" = 0 AND "terminalCount" = 0
            AND "startedAt" IS NULL AND "completedAt" IS NULL
            AND "stoppedAt" IS NULL AND "stopReason" IS NULL)
        OR ("status" = 'running' AND "dispatchCount" > 0 AND "startedAt" IS NOT NULL
            AND "completedAt" IS NULL AND "stoppedAt" IS NULL AND "stopReason" IS NULL)
        OR ("status" = 'completed' AND "dispatchCount" = 16 AND "terminalCount" = 16
            AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "stoppedAt" IS NULL AND "stopReason" IS NULL)
        OR ("status" = 'stopped_unknown' AND "dispatchCount" > 0
            AND "terminalCount" > 0 AND "startedAt" IS NOT NULL
            AND "completedAt" IS NULL AND "stoppedAt" IS NOT NULL
            AND "stopReason" = 'unknown_after_dispatch')
    )
);

CREATE UNIQUE INDEX "PromptRefinerShadowRun_runContractDigest_key"
    ON "PromptRefinerShadowRun"("runContractDigest");
CREATE UNIQUE INDEX "PromptRefinerShadowRun_authorizationAuditLogId_key"
    ON "PromptRefinerShadowRun"("authorizationAuditLogId");
CREATE INDEX "PromptRefinerShadowRun_stageId_status_idx"
    ON "PromptRefinerShadowRun"("stageId", "status");

CREATE TABLE "PromptRefinerShadowAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "caseIndex" INTEGER NOT NULL,
    "stageId" TEXT NOT NULL,
    "reservationContractDigest" TEXT NOT NULL,
    "runContractDigest" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dispatch_intent',
    "terminalReason" TEXT,
    "failureLayer" TEXT,
    "failureCode" TEXT,
    "dispatchIntentAt" TIMESTAMP(3) NOT NULL,
    "terminalAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "cacheWriteInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "actualCostMicroUsd" BIGINT,
    "dispatchAuditLogId" TEXT NOT NULL,
    "terminalAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PromptRefinerShadowAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerShadowAttempt_status_check"
        CHECK ("status" IN ('dispatch_intent', 'terminal')),
    CONSTRAINT "PromptRefinerShadowAttempt_binding_check" CHECK (
        "id" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "runId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "reservationId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "requestId" ~ '^[A-Za-z0-9:_-]{1,128}$'
        AND "caseId" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "caseIndex" BETWEEN 0 AND 15
        AND "stageId" = 'prompt-refiner-shadow-v1'
        AND "reservationContractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
        AND "runContractDigest" = 'sha256:a48ca37275c72f5a39d6029c9952d0ab4e35de7e55a4fd7086cb8a148eb6222a'
        AND "provider" = 'openai'
        AND "modelId" = 'gpt-5-6-luna'
        AND "adapterVersion" = 'prompt-refiner-openai-sdk-adapter-v1'
    ),
    CONSTRAINT "PromptRefinerShadowAttempt_nonnegative_check" CHECK (
        ("durationMs" IS NULL OR "durationMs" >= 0)
        AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
        AND ("cachedInputTokens" IS NULL OR "cachedInputTokens" >= 0)
        AND ("cacheWriteInputTokens" IS NULL OR "cacheWriteInputTokens" >= 0)
        AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
        AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
        AND ("actualCostMicroUsd" IS NULL OR ("actualCostMicroUsd" >= 0 AND "actualCostMicroUsd" <= 24916))
    ),
    CONSTRAINT "PromptRefinerShadowAttempt_terminal_check" CHECK (
        ("status" = 'dispatch_intent'
            AND "terminalReason" IS NULL AND "failureLayer" IS NULL
            AND "failureCode" IS NULL AND "terminalAt" IS NULL
            AND "durationMs" IS NULL AND "inputTokens" IS NULL
            AND "cachedInputTokens" IS NULL AND "cacheWriteInputTokens" IS NULL
            AND "outputTokens" IS NULL AND "reasoningTokens" IS NULL
            AND "actualCostMicroUsd" IS NULL AND "terminalAuditLogId" IS NULL)
        OR ("status" = 'terminal'
            AND "terminalReason" IN ('suggested', 'provider_error', 'timeout', 'invalid_response', 'empty_response', 'no_change', 'cancelled_after_dispatch', 'unknown_after_dispatch')
            AND "terminalAt" IS NOT NULL AND "terminalAuditLogId" IS NOT NULL
            AND (
                ("terminalReason" = 'suggested' AND "failureLayer" = 'none' AND "failureCode" IS NULL)
                OR ("terminalReason" IN ('provider_error', 'timeout', 'cancelled_after_dispatch', 'unknown_after_dispatch')
                    AND "failureLayer" = 'provider' AND "failureCode" IS NOT NULL)
                OR ("terminalReason" IN ('invalid_response', 'empty_response', 'no_change')
                    AND "failureLayer" = 'response_validation' AND "failureCode" = "terminalReason")
            )
        )
    ),
    CONSTRAINT "PromptRefinerShadowAttempt_time_check" CHECK (
        "createdAt" >= "dispatchIntentAt"
        AND ("terminalAt" IS NULL OR "terminalAt" >= "dispatchIntentAt")
    )
);

CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_reservationId_key"
    ON "PromptRefinerShadowAttempt"("reservationId");
CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_requestId_key"
    ON "PromptRefinerShadowAttempt"("requestId");
CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_dispatchAuditLogId_key"
    ON "PromptRefinerShadowAttempt"("dispatchAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_terminalAuditLogId_key"
    ON "PromptRefinerShadowAttempt"("terminalAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_runId_caseId_key"
    ON "PromptRefinerShadowAttempt"("runId", "caseId");
CREATE UNIQUE INDEX "PromptRefinerShadowAttempt_runId_caseIndex_key"
    ON "PromptRefinerShadowAttempt"("runId", "caseIndex");
CREATE INDEX "PromptRefinerShadowAttempt_status_dispatchIntentAt_idx"
    ON "PromptRefinerShadowAttempt"("status", "dispatchIntentAt");

ALTER TABLE "PromptRefinerShadowRun"
    ADD CONSTRAINT "PromptRefinerShadowRun_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "PromptRefinerReservationStage"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PromptRefinerShadowAttempt"
    ADD CONSTRAINT "PromptRefinerShadowAttempt_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "PromptRefinerShadowRun"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PromptRefinerShadowAttempt"
    ADD CONSTRAINT "PromptRefinerShadowAttempt_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "PromptRefinerReservation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
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
       OR audit."entryHash" IS NULL
       OR audit."entryHash" !~ '^[a-f0-9]{64}$'
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
            'executionAdmitted', false,
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
    IF NOT (
        (NEW."status" = OLD."status")
        OR (OLD."status" = 'approved' AND NEW."status" = 'running')
        OR (OLD."status" = 'running' AND NEW."status" IN ('completed', 'stopped_unknown'))
    ) THEN
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
    IF NOT FOUND OR audit."actorUserId" IS NOT NULL
       OR audit."action" <> 'prompt_refiner.shadow_dispatch.intent_recorded'
       OR audit."targetType" <> 'PromptRefinerShadowAttempt'
       OR audit."targetId" IS DISTINCT FROM NEW."id"
       OR audit."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-shadow-runner'
       OR audit."metadata"->>'runId' IS DISTINCT FROM NEW."runId"
       OR audit."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"
       OR audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"
       OR audit."metadata"->>'caseId' IS DISTINCT FROM NEW."caseId" THEN
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
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."runId" IS DISTINCT FROM OLD."runId"
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
       OR audit."metadata"->>'terminalReason' IS DISTINCT FROM NEW."terminalReason" THEN
        RAISE EXCEPTION 'PromptRefinerShadowAttempt terminal audit binding is invalid';
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    NEW."terminalAt" := observed_at;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_shadow_run_insert_guard_trigger"
BEFORE INSERT ON "PromptRefinerShadowRun"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_shadow_run_insert_guard"();
CREATE TRIGGER "prompt_refiner_shadow_run_guard_trigger"
BEFORE UPDATE OR DELETE ON "PromptRefinerShadowRun"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_shadow_run_guard"();
CREATE TRIGGER "prompt_refiner_shadow_attempt_insert_guard_trigger"
BEFORE INSERT ON "PromptRefinerShadowAttempt"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_shadow_attempt_insert_guard"();
CREATE TRIGGER "prompt_refiner_shadow_attempt_guard_trigger"
BEFORE UPDATE OR DELETE ON "PromptRefinerShadowAttempt"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_shadow_attempt_guard"();

-- A consumed reservation without a same-transaction dispatch intent is an
-- unrepairable ambiguity. Replace the existing guard with the additional
-- cross-row check; release and expiry keep their prior behaviour.
CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_guard"()
RETURNS TRIGGER AS $$
DECLARE
    observed_at TIMESTAMP(3);
    stage_expires_at TIMESTAMP(3);
    intent_count INTEGER;
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
    IF NEW."consumedAt" IS NOT NULL OR NEW."releasedAt" IS NOT NULL OR NEW."expiredAt" IS NOT NULL THEN
        RAISE EXCEPTION 'PromptRefinerReservation % terminal timestamp is database-owned', OLD."id";
    END IF;
    IF NEW."status" NOT IN ('consumed', 'released', 'expired') THEN
        RAISE EXCEPTION 'PromptRefinerReservation % transition is invalid', OLD."id";
    END IF;
    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    SELECT "approvalExpiresAt" INTO stage_expires_at FROM "PromptRefinerReservationStage"
    WHERE "id" = OLD."stageId" FOR UPDATE;
    IF NEW."status" = 'consumed' AND (stage_expires_at IS NULL OR observed_at >= stage_expires_at) THEN
        RAISE EXCEPTION 'PromptRefinerReservationStage approval expired before consume';
    END IF;
    IF NEW."status" = 'consumed' THEN
        SELECT COUNT(*)::INTEGER INTO intent_count
        FROM "PromptRefinerShadowAttempt"
        WHERE "reservationId" = OLD."id"
          AND "requestId" = OLD."requestId"
          AND "stageId" = OLD."stageId"
          AND "reservationContractDigest" = OLD."contractDigest"
          AND "status" = 'dispatch_intent';
        IF intent_count <> 1 THEN
            RAISE EXCEPTION 'PromptRefinerReservation % consume requires one dispatch intent', OLD."id";
        END IF;
    END IF;
    IF NEW."status" = 'expired' AND observed_at < OLD."expiresAt" THEN
        RAISE EXCEPTION 'PromptRefinerReservation % cannot expire before its deadline', OLD."id";
    END IF;
    IF observed_at >= OLD."expiresAt" THEN
        NEW."status" := 'expired'; NEW."expiredAt" := observed_at;
    ELSIF NEW."status" = 'consumed' THEN
        NEW."consumedAt" := observed_at;
    ELSE
        NEW."releasedAt" := observed_at;
    END IF;
    NEW."updatedAt" := observed_at;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
