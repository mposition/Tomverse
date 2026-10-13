-- Policy v42: an API-key worker has no CLI subscription quota. Admit only the
-- exact FIRST retry after one content-free, immutable model-access observation.
-- The observation never represents provider balance, quota or price.
BEGIN;

CREATE TABLE "AmuxV22ApiModelAccessEvidence" (
  "id" UUID NOT NULL,
  "launchProofId" UUID NOT NULL,
  "taskId" TEXT NOT NULL,
  "priorAttemptId" TEXT NOT NULL,
  "workerName" TEXT NOT NULL,
  "workerInstanceId" TEXT NOT NULL,
  "workerGeneration" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "providerHost" TEXT NOT NULL,
  "selectedModelId" TEXT NOT NULL,
  "canonicalModelId" TEXT,
  "apiExecutionFrameDigest" TEXT NOT NULL,
  "credentialMetadataDigest" TEXT NOT NULL,
  "launcherConfigDigest" TEXT NOT NULL,
  "accessState" TEXT NOT NULL,
  "reason" TEXT,
  "balanceKnown" BOOLEAN NOT NULL,
  "maximumCostMicroUsd" BIGINT NOT NULL,
  "worstExposureMicroUsd" BIGINT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22ApiModelAccessEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxV22ApiModelAccessEvidence_exact_first_check" CHECK (
    "id" = "launchProofId" AND
    "taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
    "priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' AND
    "provider" = 'anthropic' AND "providerHost" = 'api.anthropic.com' AND
    "balanceKnown" = false AND
    "maximumCostMicroUsd" = 3400000 AND
    "worstExposureMicroUsd" = 6800000 AND
    "workerGeneration" >= 1 AND
    length("workerName") BETWEEN 1 AND 120 AND
    length("workerInstanceId") BETWEEN 1 AND 120 AND
    length("selectedModelId") BETWEEN 1 AND 160 AND
    ("canonicalModelId" IS NULL OR length("canonicalModelId") BETWEEN 1 AND 160) AND
    length("apiExecutionFrameDigest") = 64 AND
    length("credentialMetadataDigest") = 64 AND
    length("launcherConfigDigest") = 64 AND length("evidenceDigest") = 64 AND
    "accessState" IN ('verified','unavailable','unknown') AND
    (("accessState" = 'verified' AND "canonicalModelId" IS NOT NULL AND "reason" IS NULL) OR
     ("accessState" <> 'verified' AND "canonicalModelId" IS NULL AND
      "reason" IN ('auth_failed','model_unavailable','rate_limited',
        'provider_unavailable','request_timeout','transport_unknown',
        'invalid_response','outcome_unknown')))
  )
);

CREATE UNIQUE INDEX "AmuxV22ApiModelAccessEvidence_launchProofId_key"
  ON "AmuxV22ApiModelAccessEvidence"("launchProofId");
CREATE UNIQUE INDEX "AmuxV22ApiModelAccessEvidence_evidenceDigest_key"
  ON "AmuxV22ApiModelAccessEvidence"("evidenceDigest");
CREATE UNIQUE INDEX "AmuxV22ApiModelAccessEvidence_authorizationAuditLogId_key"
  ON "AmuxV22ApiModelAccessEvidence"("authorizationAuditLogId");
CREATE INDEX "AmuxV22ApiModelAccessEvidence_task_recordedAt_idx"
  ON "AmuxV22ApiModelAccessEvidence"("taskId", "recordedAt");
CREATE INDEX "AmuxV22ApiModelAccessEvidence_worker_recordedAt_idx"
  ON "AmuxV22ApiModelAccessEvidence"("workerName", "recordedAt");

ALTER TABLE "AmuxV22ApiModelAccessEvidence"
  ADD CONSTRAINT "AmuxV22ApiModelAccessEvidence_launchProofId_fkey"
    FOREIGN KEY ("launchProofId") REFERENCES "AmuxV22ReadOnlyLaunchProof"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22ApiModelAccessEvidence_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22ApiModelAccessEvidence_priorAttemptId_fkey"
    FOREIGN KEY ("priorAttemptId") REFERENCES "AmuxExecutionAttempt"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22ApiModelAccessEvidence_audit_fkey"
    FOREIGN KEY ("authorizationAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxV22TaskRecoveryApproval"
  ADD COLUMN "apiModelAccessEvidenceId" UUID,
  ADD COLUMN "apiModelAccessEvidenceDigest" TEXT,
  ADD COLUMN "canonicalModelId" TEXT,
  ADD CONSTRAINT "AmuxV22RecoveryApproval_api_access_shape_check" CHECK (
    ("apiModelAccessEvidenceId" IS NULL AND
     "apiModelAccessEvidenceDigest" IS NULL AND "canonicalModelId" IS NULL) OR
    ("apiModelAccessEvidenceId" IS NOT NULL AND
     length("apiModelAccessEvidenceDigest") = 64 AND
     length("canonicalModelId") BETWEEN 1 AND 160)
  );
CREATE UNIQUE INDEX "AmuxV22TaskRecoveryApproval_apiModelAccessEvidenceId_key"
  ON "AmuxV22TaskRecoveryApproval"("apiModelAccessEvidenceId");
ALTER TABLE "AmuxV22TaskRecoveryApproval"
  ADD CONSTRAINT "AmuxV22RecoveryApproval_apiModelAccessEvidenceId_fkey"
    FOREIGN KEY ("apiModelAccessEvidenceId")
      REFERENCES "AmuxV22ApiModelAccessEvidence"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER amux_v22_api_model_access_immutable BEFORE UPDATE OR DELETE
  ON "AmuxV22ApiModelAccessEvidence" FOR EACH STATEMENT
  EXECUTE FUNCTION amux_v22_v39_reject_mutation();

CREATE FUNCTION amux_v22_v42_model_access_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
  launch_check "AmuxV22ReadOnlyLaunchCheck"%ROWTYPE;
  audit "AdminAuditLog"%ROWTYPE;
  task "AmuxWorkItem"%ROWTYPE;
  runtime "AmuxWorkerRuntime"%ROWTYPE;
  db_now TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = NEW."launchProofId" FOR KEY SHARE;
  SELECT * INTO launch_check FROM "AmuxV22ReadOnlyLaunchCheck"
    WHERE "id" = proof."launchCheckId" FOR KEY SHARE;
  SELECT * INTO audit FROM "AdminAuditLog"
    WHERE "id" = NEW."authorizationAuditLogId" FOR KEY SHARE;
  SELECT * INTO task FROM "AmuxWorkItem"
    WHERE "id" = NEW."taskId" FOR KEY SHARE;
  SELECT * INTO runtime FROM "AmuxWorkerRuntime"
    WHERE "workerName" = NEW."workerName" FOR KEY SHARE;
  IF proof."id" IS NULL OR NOT proof."verified" OR launch_check."id" IS NULL OR
     proof."recordedAt" > db_now OR
     db_now - proof."recordedAt" > INTERVAL '90 seconds' OR
     NEW."recordedAt" > db_now OR db_now - NEW."recordedAt" > INTERVAL '5 seconds' OR
     NEW."recordedAt" < proof."recordedAt" OR
     launch_check."taskId" IS DISTINCT FROM NEW."taskId" OR
     launch_check."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
     launch_check."workerName" IS DISTINCT FROM NEW."workerName" OR
     launch_check."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     launch_check."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
     launch_check."provider" IS DISTINCT FROM NEW."provider" OR
     launch_check."modelId" IS DISTINCT FROM NEW."selectedModelId" OR
     proof."report" #>> '{launchScope,executorKind}' IS DISTINCT FROM
       'read_only_api_retry_v1' OR
     proof."report" #>> '{launchScope,apiExecutionFrameDigest}' IS DISTINCT FROM
       NEW."apiExecutionFrameDigest" OR
     proof."report" #>> '{launchScope,launcherConfigDigest}' IS DISTINCT FROM
       NEW."launcherConfigDigest" OR
     proof."report" #>> '{apiExecutionFrame,credentialMetadataDigest}' IS DISTINCT FROM
       NEW."credentialMetadataDigest" OR
     launch_check."additionalCapMicroUsd" <> 3400000 OR
     launch_check."worstExposureMicroUsd" <> 6800000 OR
     task."status" IS DISTINCT FROM 'blocked' OR
     task."revision" IS DISTINCT FROM launch_check."taskRevision" OR
     task."owner" IS NOT NULL OR task."claimedAt" IS NOT NULL OR
     task."v22AssignmentId" IS NOT NULL OR runtime."instanceId" IS DISTINCT FROM
       NEW."workerInstanceId" OR runtime."generation" IS DISTINCT FROM
       NEW."workerGeneration" OR runtime."status" IS DISTINCT FROM 'idle' OR
     NOT runtime."dispatchReady" OR runtime."leaseExpiresAt" <= db_now OR
     runtime."protocolCapabilities" IS DISTINCT FROM ARRAY['read_only_api_retry_v1']::TEXT[] OR
     audit."action" IS DISTINCT FROM 'amux.v22.recovery.api_model_access_observed' OR
     audit."targetType" IS DISTINCT FROM 'AmuxV22ApiModelAccessEvidence' OR
     audit."targetId" IS DISTINCT FROM NEW."id" OR audit."entryHash" IS NULL OR
     audit."metadata" ->> 'systemActor' IS DISTINCT FROM
       'amux-v22-api-model-access' OR
     audit."metadata" ->> 'evidenceDigest' IS DISTINCT FROM NEW."evidenceDigest" OR
     audit."metadata" ->> 'launchProofId' IS DISTINCT FROM NEW."launchProofId"::TEXT OR
     audit.xmin IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'API model access evidence is not bound to current launch authority'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22ApiModelAccessEvidence_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_api_model_access_insert_guard BEFORE INSERT
  ON "AmuxV22ApiModelAccessEvidence" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v42_model_access_insert_guard();

CREATE FUNCTION amux_v22_v42_approval_model_access_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
  evidence "AmuxV22ApiModelAccessEvidence"%ROWTYPE;
BEGIN
  IF NEW."launchProofId" IS NULL THEN
    IF NEW."apiModelAccessEvidenceId" IS NOT NULL THEN
      RAISE EXCEPTION 'non-recovery approval cannot bind API model access'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV22RecoveryApproval_api_access_binding_check';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = NEW."launchProofId" FOR KEY SHARE;
  IF proof."report" #>> '{launchScope,executorKind}' = 'read_only_api_retry_v1' THEN
    SELECT * INTO evidence FROM "AmuxV22ApiModelAccessEvidence"
      WHERE "id" = NEW."apiModelAccessEvidenceId" FOR KEY SHARE;
    IF evidence."id" IS NULL OR evidence."launchProofId" IS DISTINCT FROM proof."id" OR
       evidence."accessState" IS DISTINCT FROM 'verified' OR
       evidence."evidenceDigest" IS DISTINCT FROM NEW."apiModelAccessEvidenceDigest" OR
       evidence."taskId" IS DISTINCT FROM NEW."taskId" OR
       evidence."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
       evidence."workerName" IS DISTINCT FROM NEW."workerName" OR
       evidence."provider" IS DISTINCT FROM NEW."provider" OR
       evidence."selectedModelId" IS DISTINCT FROM NEW."modelId" OR
       evidence."canonicalModelId" IS DISTINCT FROM NEW."canonicalModelId" OR
       evidence."canonicalModelId" IS DISTINCT FROM evidence."selectedModelId" OR
       evidence."balanceKnown" OR
       NEW."approvedAt" < evidence."recordedAt" OR
       NEW."approvedAt" > evidence."recordedAt" + INTERVAL '90 seconds' THEN
      RAISE EXCEPTION 'API recovery approval requires fresh exact model access evidence'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV22RecoveryApproval_api_access_binding_check';
    END IF;
  ELSIF NEW."apiModelAccessEvidenceId" IS NOT NULL THEN
    RAISE EXCEPTION 'CLI recovery approval cannot bind API model access'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryApproval_api_access_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_v42_approval_model_access_guard BEFORE INSERT
  ON "AmuxV22TaskRecoveryApproval" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v42_approval_model_access_guard();

CREATE FUNCTION amux_v22_v42_assignment_model_access_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
  evidence "AmuxV22ApiModelAccessEvidence"%ROWTYPE;
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = NEW."recoveryApprovalId" FOR KEY SHARE;
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = approval."launchProofId" FOR KEY SHARE;
  IF proof."report" #>> '{launchScope,executorKind}' <> 'read_only_api_retry_v1'
    THEN RETURN NEW; END IF;
  SELECT * INTO evidence FROM "AmuxV22ApiModelAccessEvidence"
    WHERE "id" = approval."apiModelAccessEvidenceId" FOR KEY SHARE;
  IF evidence."accessState" IS DISTINCT FROM 'verified' OR
     evidence."recordedAt" + INTERVAL '90 seconds' < CURRENT_TIMESTAMP OR
     evidence."workerName" IS DISTINCT FROM NEW."workerName" OR
     evidence."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     evidence."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
     evidence."provider" IS DISTINCT FROM NEW."provider" OR
     evidence."selectedModelId" IS DISTINCT FROM NEW."modelId" OR
     evidence."canonicalModelId" IS DISTINCT FROM NEW."modelId" OR
     evidence."apiExecutionFrameDigest" IS DISTINCT FROM
       proof."report" #>> '{launchScope,apiExecutionFrameDigest}' OR
     evidence."launcherConfigDigest" IS DISTINCT FROM
       proof."report" #>> '{launchScope,launcherConfigDigest}' THEN
    RAISE EXCEPTION 'API assignment requires fresh exact model access evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22Assignment_api_access_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_v42_assignment_model_access_guard BEFORE INSERT
  ON "AmuxV22WorkerAssignment" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v42_assignment_model_access_guard();

CREATE FUNCTION amux_v22_v42_attempt_model_access_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  assignment "AmuxV22WorkerAssignment"%ROWTYPE;
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
  evidence "AmuxV22ApiModelAccessEvidence"%ROWTYPE;
BEGIN
  IF NEW."taskId" <> 'c48886b9-86f8-4631-8db8-c0b288a707af' OR
     NEW."attemptNumber" <> 2 THEN RETURN NEW; END IF;
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
    WHERE "id" = NEW."v22AssignmentId" FOR KEY SHARE;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = assignment."recoveryApprovalId" FOR KEY SHARE;
  IF approval."apiModelAccessEvidenceId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO evidence FROM "AmuxV22ApiModelAccessEvidence"
    WHERE "id" = approval."apiModelAccessEvidenceId" FOR KEY SHARE;
  IF evidence."accessState" IS DISTINCT FROM 'verified' OR
     evidence."recordedAt" + INTERVAL '90 seconds' < CURRENT_TIMESTAMP OR
     evidence."workerName" IS DISTINCT FROM NEW."worker" OR
     evidence."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     evidence."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
     evidence."selectedModelId" IS DISTINCT FROM assignment."modelId" OR
     evidence."canonicalModelId" IS DISTINCT FROM assignment."modelId" THEN
    RAISE EXCEPTION 'API attempt requires fresh exact model access evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAttempt_api_access_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v42_attempt_model_access_guard
  AFTER INSERT ON "AmuxExecutionAttempt" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v42_attempt_model_access_guard();

COMMIT;
