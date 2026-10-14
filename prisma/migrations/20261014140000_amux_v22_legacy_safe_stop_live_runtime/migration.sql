-- baseline-check: replace-function-if-body-sha256 "amux_v22_recovery_inspection_guard" "1cf7cc10f5a47b2b74b4d6b733fc4efaf63e55d1b419fd9fe8473aa559df829c"
-- Policy v45 (owner-approved 2026-10-14): a legacy safe stop binds the worker
-- profile's live runtime instead of the prior attempt's, which any restart since
-- that attempt has already replaced. The live-runtime match, idle-profile,
-- source, risk and audit checks are unchanged; an inspect request and every
-- source request stay bound to the prior attempt's runtime, so a stop bound to
-- a newer live runtime cannot seed a chained request.
BEGIN;

CREATE OR REPLACE FUNCTION public.amux_v22_recovery_inspection_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  w "AmuxWorkItem"%ROWTYPE; p "AmuxExecutionAttempt"%ROWTYPE;
  source_e "AmuxV22TaskRecoveryEvidence"%ROWTYPE;
  source_r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
  risk "AmuxV22TaskRecoveryRiskAcceptance"%ROWTYPE;
  request_action TEXT; source_allowed BOOLEAN := false;
BEGIN
  IF NEW."requestKind" = 'safe_stop' THEN
    PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
    PERFORM 1 FROM "AmuxWorkerRuntime" WHERE "workerName" = ANY(NEW."profileWorkerNames")
      ORDER BY "workerName" FOR UPDATE;
  END IF;
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT * INTO p FROM "AmuxExecutionAttempt" WHERE "id" = NEW."priorAttemptId";
  request_action := CASE NEW."requestKind" WHEN 'inspect' THEN 'amux.v22.recovery.requested'
    WHEN 'safe_stop' THEN 'amux.v22.recovery.safe_stop_requested' ELSE NULL END;
  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     w."cardType" IS DISTINCT FROM 'task' OR w."status" IS DISTINCT FROM 'blocked' OR
     w."revision" IS DISTINCT FROM NEW."taskRevision" OR w."owner" IS NOT NULL OR
     w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     p."taskId" IS DISTINCT FROM NEW."taskId" OR p."worker" IS DISTINCT FROM NEW."workerName" OR
     p."taskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
     (NEW."requestKind" = 'inspect' AND
       (p."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
        p."workerGeneration" IS DISTINCT FROM NEW."workerGeneration")) OR
     p."endedAt" IS NULL OR
     NOT (p."outcome" IN ('expired','outcome_unknown') OR
       p."reason" IN ('outcome_unknown','usage_outcome_unknown')) OR
     EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = p."taskId" AND
       a."taskRevision" > p."taskRevision") OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE
       a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = request_action AND
       a."targetType" = 'AmuxV22TaskRecoveryInspectionRequest' AND
       a."targetId" = NEW."id"::text AND a."actorUserId" = NEW."requestedByUserId" AND
       NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'requestDigest' = NEW."requestDigest" AND
       a."metadata"->>'taskId' = NEW."taskId" AND
       a."metadata"->>'priorAttemptId' = NEW."priorAttemptId" AND
       (NEW."requestKind" = 'inspect' OR
        (a."metadata"->>'sourceEvidenceId' = NEW."sourceEvidenceId"::text AND
         a."metadata"->>'sourceEvidenceDigest' = NEW."sourceEvidenceDigest" AND
         a."metadata"->>'workerProfileAlias' = NEW."workerProfileAlias" AND
         a."metadata"->>'profileConfigDigest' = NEW."profileConfigDigest" AND
         a."metadata"->>'targetUnit' = NEW."targetUnit" AND
         coalesce(a."metadata"->>'riskAcceptanceId','') =
           coalesce(NEW."riskAcceptanceId"::text,'') AND
         coalesce(a."metadata"->>'riskAcceptanceDigest','') =
           coalesce(NEW."riskAcceptanceDigest",''))) AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery request is not exact and human audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryInspection_binding_check';
  END IF;
  IF NEW."requestKind" = 'safe_stop' THEN
    SELECT * INTO source_e FROM "AmuxV22TaskRecoveryEvidence" WHERE "id" = NEW."sourceEvidenceId";
    SELECT * INTO source_r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = source_e."inspectionId";
    IF source_r."requestKind" = 'inspect' AND source_e."requestKind" = 'inspect' AND
       NOT source_e."verified" AND source_e."reason" = 'legacy_invocation_unbound' AND
       source_e."report"->'proof'->>'terminalOutcome' <> 'succeeded' THEN
      IF source_e."report"->'proof'->'externalEffectsKnown' = 'true'::jsonb AND
         NEW."riskAcceptanceId" IS NULL THEN source_allowed := true;
      ELSIF source_e."report"->'proof'->'externalEffectsKnown' = 'false'::jsonb AND
         NEW."riskAcceptanceId" IS NOT NULL THEN
        SELECT * INTO risk FROM "AmuxV22TaskRecoveryRiskAcceptance"
          WHERE "id" = NEW."riskAcceptanceId";
        source_allowed := risk."taskId" = NEW."taskId" AND
          risk."taskRevision" = NEW."taskRevision" AND
          risk."priorAttemptId" = NEW."priorAttemptId" AND
          risk."sourceEvidenceId" = source_e."id" AND
          risk."sourceEvidenceDigest" = source_e."evidenceDigest" AND
          risk."acceptanceDigest" = NEW."riskAcceptanceDigest";
      END IF;
    ELSIF source_r."requestKind" = 'safe_stop' AND source_e."requestKind" = 'safe_stop' AND
       source_r."workerProfileAlias" = NEW."workerProfileAlias" AND
       source_r."profileWorkerNames" = NEW."profileWorkerNames" AND
       source_r."targetUnit" = NEW."targetUnit" AND
       source_r."profileConfigDigest" = NEW."profileConfigDigest" AND
       source_r."riskAcceptanceId" IS NOT DISTINCT FROM NEW."riskAcceptanceId" AND
       source_r."riskAcceptanceDigest" IS NOT DISTINCT FROM NEW."riskAcceptanceDigest" THEN
      source_allowed := true;
    END IF;
    IF w."taskRole" IS DISTINCT FROM 'investigate' OR
       source_allowed IS DISTINCT FROM true OR
       source_e."evidenceDigest" IS DISTINCT FROM NEW."sourceEvidenceDigest" OR
       source_r."taskId" IS DISTINCT FROM NEW."taskId" OR
       source_r."taskRevision" IS DISTINCT FROM NEW."taskRevision" OR
       source_r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
       source_r."priorAttemptTaskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
       source_r."workerName" IS DISTINCT FROM NEW."workerName" OR
       source_r."workerInstanceId" IS DISTINCT FROM p."workerInstanceId" OR
       source_r."workerGeneration" IS DISTINCT FROM p."workerGeneration" OR
       source_r."targetHost" IS DISTINCT FROM NEW."targetHost" OR
       NEW."workerName" <> ALL(NEW."profileWorkerNames") OR
       NEW."profileWorkerNames" IS DISTINCT FROM
         ARRAY(SELECT name FROM unnest(NEW."profileWorkerNames") AS name ORDER BY name) OR
       (SELECT count(DISTINCT name) FROM unnest(NEW."profileWorkerNames") AS name)
         IS DISTINCT FROM cardinality(NEW."profileWorkerNames") OR
       (SELECT count(*) FROM "AmuxWorkerRuntime" runtime
         WHERE runtime."workerName" = ANY(NEW."profileWorkerNames") AND
           runtime."instanceId" = NEW."workerInstanceId" AND
           runtime."generation" = NEW."workerGeneration")
         IS DISTINCT FROM cardinality(NEW."profileWorkerNames") OR
       EXISTS (SELECT 1 FROM "AmuxWorkItem" other WHERE other."id" <> NEW."taskId" AND
         other."archivedAt" IS NULL AND other."status" NOT IN ('done','cancelled') AND
         other."owner" = ANY(NEW."profileWorkerNames")) OR
       EXISTS (SELECT 1 FROM "AmuxV22WorkerAssignment" assignment
         JOIN "AmuxWorkItem" other ON other."v22AssignmentId" = assignment."id"
         WHERE other."id" <> NEW."taskId" AND
           assignment."workerName" = ANY(NEW."profileWorkerNames")) OR
       EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" attempt
         WHERE attempt."id" <> NEW."priorAttemptId" AND
           attempt."worker" = ANY(NEW."profileWorkerNames") AND
           (attempt."endedAt" IS NULL OR attempt."outcome" IS NULL OR
            attempt."outcome" = 'outcome_unknown' OR
            attempt."reason" IN ('outcome_unknown','usage_outcome_unknown'))) OR
       EXISTS (SELECT 1 FROM "AmuxWorkDelivery" delivery
         WHERE delivery."worker" = ANY(NEW."profileWorkerNames") AND
           delivery."status" IN ('queued','leased')) THEN
      RAISE EXCEPTION 'Legacy safe-stop request is not an accepted idle physical profile'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_request_guard_check';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

COMMIT;
