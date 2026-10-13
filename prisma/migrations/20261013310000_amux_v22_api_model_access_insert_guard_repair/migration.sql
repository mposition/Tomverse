-- baseline-check: replace-function-if-body-sha256 "amux_v22_v42_model_access_insert_guard" "74675c009ac55cc580483aabecf47a1f7042f2ecf86e94dd1b9fc60a38c2d454"
-- Policy v42 repair: migration 300 compared AdminAuditLog."targetId" (TEXT)
-- with the evidence UUID without a cast, so every evidence insert raised 42883
-- and no API model-access observation could be recorded. Replace only that
-- comparison; every other condition of the 300 body is byte-identical.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v22_v42_model_access_insert_guard() RETURNS trigger
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
     audit."targetId" IS DISTINCT FROM NEW."id"::TEXT OR audit."entryHash" IS NULL OR
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

COMMIT;
