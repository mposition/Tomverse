-- Policy v39. Additive FIRST Task UNKNOWN-risk acceptance and read-only retry
-- preflight only. No backfill, activation, reservation or execution.
BEGIN;

ALTER TABLE "AmuxWorkerRuntime"
  ADD COLUMN "protocolCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "AmuxWorkerRuntime_protocolCapabilities_check" CHECK (
    "protocolCapabilities" IN (ARRAY[]::TEXT[], ARRAY['read_only_retry_v1']::TEXT[]));

CREATE TABLE "AmuxV22TaskRecoveryRiskAcceptance" (
  "id" UUID NOT NULL PRIMARY KEY,
  "ownerRequestId" UUID NOT NULL UNIQUE,
  "taskId" TEXT NOT NULL,
  "taskRevision" INTEGER NOT NULL,
  "priorAttemptId" TEXT NOT NULL,
  "priorAttemptTaskRevision" INTEGER NOT NULL,
  "sourceEvidenceId" UUID NOT NULL,
  "sourceEvidenceDigest" TEXT NOT NULL,
  "briefDigest" TEXT NOT NULL,
  "launchBindingId" UUID NOT NULL UNIQUE,
  "oldHeldMicroUsd" BIGINT NOT NULL,
  "additionalCapMicroUsd" BIGINT NOT NULL,
  "worstExposureMicroUsd" BIGINT NOT NULL,
  "acceptanceDigest" TEXT NOT NULL UNIQUE,
  "acceptedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RiskAcceptance_exact_target_check" CHECK (
    "taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
    "priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' AND
    "oldHeldMicroUsd" = 3400000 AND "additionalCapMicroUsd" = 3400000 AND
    "worstExposureMicroUsd" = 6800000 AND
    "sourceEvidenceDigest" ~ '^[a-f0-9]{64}$' AND
    "briefDigest" ~ '^[a-f0-9]{64}$' AND
    "acceptanceDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AmuxV22RiskAcceptance_task_attempt_key"
    UNIQUE ("taskId", "priorAttemptId"),
  CONSTRAINT "AmuxV22RiskAcceptance_task_fkey" FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22RiskAcceptance_attempt_fkey" FOREIGN KEY ("priorAttemptId")
    REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22RiskAcceptance_evidence_fkey" FOREIGN KEY ("sourceEvidenceId")
    REFERENCES "AmuxV22TaskRecoveryEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22RiskAcceptance_audit_fkey" FOREIGN KEY ("authorizationAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AmuxV22RiskAcceptance_sourceEvidenceId_idx"
  ON "AmuxV22TaskRecoveryRiskAcceptance"("sourceEvidenceId");

ALTER TABLE "AmuxV22TaskRecoveryInspectionRequest"
  ADD COLUMN "riskAcceptanceId" UUID,
  ADD COLUMN "riskAcceptanceDigest" TEXT,
  ADD CONSTRAINT "AmuxV22RecoveryRequest_riskAcceptanceId_fkey"
    FOREIGN KEY ("riskAcceptanceId") REFERENCES "AmuxV22TaskRecoveryRiskAcceptance"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22RecoveryRequest_risk_shape_check" CHECK (
    ("riskAcceptanceId" IS NULL AND "riskAcceptanceDigest" IS NULL) OR
    ("requestKind" = 'safe_stop' AND "riskAcceptanceId" IS NOT NULL AND
      "riskAcceptanceDigest" ~ '^[a-f0-9]{64}$'));

CREATE TABLE "AmuxV22ReadOnlyLaunchCheck" (
  "id" UUID NOT NULL PRIMARY KEY,
  "requestDigest" TEXT NOT NULL UNIQUE,
  "riskAcceptanceId" UUID NOT NULL,
  "riskAcceptanceDigest" TEXT NOT NULL,
  "sourceEvidenceId" UUID NOT NULL UNIQUE,
  "sourceEvidenceDigest" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "taskRevision" INTEGER NOT NULL,
  "priorAttemptId" TEXT NOT NULL,
  "workerName" TEXT NOT NULL,
  "workerInstanceId" TEXT NOT NULL,
  "workerGeneration" INTEGER NOT NULL,
  "targetHost" TEXT NOT NULL,
  "launchBindingId" UUID NOT NULL,
  "briefDigest" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "routeId" TEXT NOT NULL,
  "routePolicyDigest" TEXT NOT NULL,
  "catalogApprovalId" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "costReceiptDigest" TEXT NOT NULL,
  "costDigest" TEXT NOT NULL,
  "additionalCapMicroUsd" BIGINT NOT NULL,
  "worstExposureMicroUsd" BIGINT NOT NULL,
  "launchScope" JSONB NOT NULL,
  "launchScopeDigest" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_shape_check" CHECK (
    "taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
    "priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' AND
    "targetHost" = 'amux-ubuntu' AND "workerGeneration" >= 1 AND
    "provider" = 'anthropic' AND "modelId" ~ '^claude-[A-Za-z0-9._-]{1,120}$' AND
    "additionalCapMicroUsd" BETWEEN 1 AND 3400000 AND
    "worstExposureMicroUsd" = 3400000 + "additionalCapMicroUsd" AND
    "worstExposureMicroUsd" <= 6800000 AND
    "requestDigest" ~ '^[a-f0-9]{64}$' AND
    "riskAcceptanceDigest" ~ '^[a-f0-9]{64}$' AND
    "sourceEvidenceDigest" ~ '^[a-f0-9]{64}$' AND
    "briefDigest" ~ '^[a-f0-9]{64}$' AND
    "routePolicyDigest" ~ '^[a-f0-9]{64}$' AND
    "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND
    "costDigest" ~ '^[a-f0-9]{64}$' AND
    "launchScopeDigest" ~ '^[a-f0-9]{64}$' AND
    jsonb_typeof("launchScope") = 'object' AND pg_column_size("launchScope") <= 2048 AND
    "launchScope"->>'version' = '1' AND
    "launchScope"->>'launcherPolicyVersion' = 'amux-v22-read-only-retry-v1' AND
    "launchScope"->>'role' = 'investigate' AND
    "launchScope"->'allowedTools' = '["Glob","Grep","Read"]'::jsonb),
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_risk_fkey" FOREIGN KEY ("riskAcceptanceId")
    REFERENCES "AmuxV22TaskRecoveryRiskAcceptance"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_source_fkey" FOREIGN KEY ("sourceEvidenceId")
    REFERENCES "AmuxV22TaskRecoveryEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_task_fkey" FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_attempt_fkey" FOREIGN KEY ("priorAttemptId")
    REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ReadOnlyLaunchCheck_audit_fkey" FOREIGN KEY ("authorizationAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AmuxV22ReadOnlyLaunchCheck_task_requestedAt_idx"
  ON "AmuxV22ReadOnlyLaunchCheck"("taskId", "requestedAt");
CREATE INDEX "AmuxV22ReadOnlyLaunchCheck_risk_requestedAt_idx"
  ON "AmuxV22ReadOnlyLaunchCheck"("riskAcceptanceId", "requestedAt");

CREATE TABLE "AmuxV22ReadOnlyLaunchProof" (
  "id" UUID NOT NULL PRIMARY KEY,
  "launchCheckId" UUID NOT NULL UNIQUE,
  "proofDigest" TEXT NOT NULL UNIQUE,
  "observation" TEXT NOT NULL,
  "report" JSONB NOT NULL,
  "verified" BOOLEAN NOT NULL,
  "reason" TEXT,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22ReadOnlyLaunchProof_shape_check" CHECK (
    "proofDigest" ~ '^[a-f0-9]{64}$' AND
    "observation" IN ('current','worker_identity_changed','launcher_config_mismatch',
      'profile_config_mismatch','scope_mismatch') AND
    jsonb_typeof("report") = 'object' AND pg_column_size("report") <= 8192 AND
    (("verified" AND "observation" = 'current' AND "reason" IS NULL) OR
     (NOT "verified" AND "reason" IS NOT NULL))),
  CONSTRAINT "AmuxV22ReadOnlyLaunchProof_check_fkey" FOREIGN KEY ("launchCheckId")
    REFERENCES "AmuxV22ReadOnlyLaunchCheck"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22ReadOnlyLaunchProof_audit_fkey" FOREIGN KEY ("authorizationAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AmuxV22ReadOnlyLaunchProof_recordedAt_idx"
  ON "AmuxV22ReadOnlyLaunchProof"("recordedAt");

ALTER TABLE "AmuxV22TaskRecoveryApproval"
  ADD COLUMN "riskAcceptanceId" UUID,
  ADD COLUMN "riskAcceptanceDigest" TEXT,
  ADD COLUMN "launchProofId" UUID,
  ADD COLUMN "launchProofDigest" TEXT,
  ADD COLUMN "launchBindingId" UUID,
  ADD COLUMN "launchScopeDigest" TEXT,
  ADD COLUMN "workerName" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "modelId" TEXT,
  ADD COLUMN "routeId" TEXT,
  ADD COLUMN "routePolicyDigest" TEXT,
  ADD COLUMN "briefDigest" TEXT,
  ADD COLUMN "profileConfigDigest" TEXT,
  ADD CONSTRAINT "AmuxV22RecoveryApproval_riskAcceptanceId_fkey"
    FOREIGN KEY ("riskAcceptanceId") REFERENCES "AmuxV22TaskRecoveryRiskAcceptance"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22RecoveryApproval_launchProofId_fkey"
    FOREIGN KEY ("launchProofId") REFERENCES "AmuxV22ReadOnlyLaunchProof"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22RecoveryApproval_v39_shape_check" CHECK (
    ("riskAcceptanceId" IS NULL AND "riskAcceptanceDigest" IS NULL AND
      "launchProofId" IS NULL AND "launchProofDigest" IS NULL AND
      "launchBindingId" IS NULL AND "launchScopeDigest" IS NULL AND
      "workerName" IS NULL AND "provider" IS NULL AND "modelId" IS NULL AND
      "routeId" IS NULL AND "routePolicyDigest" IS NULL AND
      "briefDigest" IS NULL AND "profileConfigDigest" IS NULL) OR
    ("taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
      "priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8' AND
      "riskAcceptanceId" IS NOT NULL AND "launchProofId" IS NOT NULL AND
      "launchBindingId" IS NOT NULL AND "workerName" IS NOT NULL AND
      "provider" IS NOT NULL AND "modelId" IS NOT NULL AND "routeId" IS NOT NULL AND
      "riskAcceptanceDigest" ~ '^[a-f0-9]{64}$' AND
      "launchProofDigest" ~ '^[a-f0-9]{64}$' AND
      "launchScopeDigest" ~ '^[a-f0-9]{64}$' AND
      "routePolicyDigest" ~ '^[a-f0-9]{64}$' AND
      "briefDigest" ~ '^[a-f0-9]{64}$' AND
      "profileConfigDigest" ~ '^[a-f0-9]{64}$' AND
      "historicalAttempts" = 1 AND "nextAttemptNumber" = 2 AND
      "oldHeldMicroUsd" = 3400000 AND
      "additionalCapMicroUsd" BETWEEN 1 AND 3400000 AND
      "worstExposureMicroUsd" = "oldHeldMicroUsd" + "additionalCapMicroUsd" AND
      "worstExposureMicroUsd" <= 6800000));
CREATE UNIQUE INDEX "AmuxV22RecoveryApproval_riskAcceptanceId_key"
  ON "AmuxV22TaskRecoveryApproval"("riskAcceptanceId")
  WHERE "riskAcceptanceId" IS NOT NULL;

CREATE FUNCTION amux_v22_v39_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'AMUX v39 evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22V39_append_only_check';
END $$;
CREATE TRIGGER amux_v22_risk_acceptance_immutable BEFORE UPDATE OR DELETE
  ON "AmuxV22TaskRecoveryRiskAcceptance" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_reject_mutation();
CREATE TRIGGER amux_v22_launch_check_immutable BEFORE UPDATE OR DELETE
  ON "AmuxV22ReadOnlyLaunchCheck" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_reject_mutation();
CREATE TRIGGER amux_v22_launch_proof_immutable BEFORE UPDATE OR DELETE
  ON "AmuxV22ReadOnlyLaunchProof" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_reject_mutation();

CREATE FUNCTION amux_v22_v39_risk_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "AmuxWorkItem"%ROWTYPE; p "AmuxExecutionAttempt"%ROWTYPE;
 e "AmuxV22TaskRecoveryEvidence"%ROWTYPE; r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
 used INTEGER; held BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId" FOR UPDATE;
  SELECT * INTO p FROM "AmuxExecutionAttempt" WHERE "id" = NEW."priorAttemptId" FOR UPDATE;
  SELECT * INTO e FROM "AmuxV22TaskRecoveryEvidence" WHERE "id" = NEW."sourceEvidenceId";
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = e."inspectionId";
  SELECT count(*)::integer, coalesce(sum("reservedCostMicrousd"),0)
    INTO used, held FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";
  IF w."status" IS DISTINCT FROM 'blocked' OR w."revision" IS DISTINCT FROM NEW."taskRevision" OR
     w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     w."taskRole" IS DISTINCT FROM 'investigate' OR
     w."v4BriefDigest" IS DISTINCT FROM NEW."briefDigest" OR
     p."taskId" IS DISTINCT FROM NEW."taskId" OR
     p."taskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
     p."endedAt" IS NULL OR p."reservedCostMicrousd" IS DISTINCT FROM 3400000 OR
     used IS DISTINCT FROM 1 OR held IS DISTINCT FROM 3400000 OR
     e."requestKind" IS DISTINCT FROM 'inspect' OR e."verified" OR
     e."reason" IS DISTINCT FROM 'legacy_invocation_unbound' OR
     e."evidenceDigest" IS DISTINCT FROM NEW."sourceEvidenceDigest" OR
     e."report"->'proof'->'externalEffectsKnown' IS DISTINCT FROM 'false'::jsonb OR
     e."report"->'proof'->>'terminalOutcome' = 'succeeded' OR
     r."taskId" IS DISTINCT FROM NEW."taskId" OR
     r."taskRevision" IS DISTINCT FROM NEW."taskRevision" OR
     r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
       WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.unknown_prior_risk_accepted' AND
       a."targetType" = 'AmuxV22TaskRecoveryRiskAcceptance' AND
       a."targetId" = NEW."id"::text AND a."actorUserId" = NEW."acceptedByUserId" AND
       NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'acceptanceDigest' = NEW."acceptanceDigest" AND
       a."metadata"->>'sourceEvidenceId' = NEW."sourceEvidenceId"::text AND
       a."metadata"->>'launchBindingId' = NEW."launchBindingId"::text AND
       a."metadata"->>'priorEffects' = 'unknown' AND
       a."metadata"->>'executionStarted' = 'false' AND
       a."metadata"->>'reservationCreated' = 'false' AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'FIRST Task UNKNOWN risk acceptance is not exact and audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RiskAcceptance_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_risk_acceptance_guard_trigger AFTER INSERT
  ON "AmuxV22TaskRecoveryRiskAcceptance" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_risk_acceptance_guard();

-- Replace only the current function body. The two applied v36/v37 migrations
-- remain immutable. Normal inspect and verified-source safe-stop behavior is
-- preserved; the new branch is the exact accepted FIRST Task only.
CREATE OR REPLACE FUNCTION amux_v22_recovery_inspection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
     p."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     p."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR p."endedAt" IS NULL OR
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
       source_r."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
       source_r."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
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
END $$;

CREATE FUNCTION amux_v22_v39_launch_check_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE risk "AmuxV22TaskRecoveryRiskAcceptance"%ROWTYPE;
 e "AmuxV22TaskRecoveryEvidence"%ROWTYPE; r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
 w "AmuxWorkItem"%ROWTYPE;
BEGIN
  SELECT * INTO risk FROM "AmuxV22TaskRecoveryRiskAcceptance" WHERE "id" = NEW."riskAcceptanceId";
  SELECT * INTO e FROM "AmuxV22TaskRecoveryEvidence" WHERE "id" = NEW."sourceEvidenceId";
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = e."inspectionId";
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  IF risk."acceptanceDigest" IS DISTINCT FROM NEW."riskAcceptanceDigest" OR
     risk."taskId" IS DISTINCT FROM NEW."taskId" OR
     risk."taskRevision" IS DISTINCT FROM NEW."taskRevision" OR
     risk."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
     risk."launchBindingId" IS DISTINCT FROM NEW."launchBindingId" OR
     risk."briefDigest" IS DISTINCT FROM NEW."briefDigest" OR
     w."status" IS DISTINCT FROM 'blocked' OR w."revision" IS DISTINCT FROM NEW."taskRevision" OR
     w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     w."v4BriefDigest" IS DISTINCT FROM NEW."briefDigest" OR
     e."verified" IS DISTINCT FROM true OR e."reason" IS NOT NULL OR
     e."requestKind" IS DISTINCT FROM 'safe_stop' OR
     e."processState" IS DISTINCT FROM 'gone' OR
     e."evidenceDigest" IS DISTINCT FROM NEW."sourceEvidenceDigest" OR
     r."riskAcceptanceId" IS DISTINCT FROM risk."id" OR
     r."riskAcceptanceDigest" IS DISTINCT FROM risk."acceptanceDigest" OR
     NEW."workerName" = ANY(r."profileWorkerNames") OR
     NOT EXISTS (SELECT 1 FROM "AmuxWorkerRuntime" runtime WHERE
       runtime."workerName" = NEW."workerName" AND
       runtime."instanceId" = NEW."workerInstanceId" AND
       runtime."generation" = NEW."workerGeneration") OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE
       a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.read_only_launch_requested' AND
       a."targetType" = 'AmuxV22ReadOnlyLaunchCheck' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND
       a."userAgent" IS NULL AND
       a."metadata"->>'systemActor' = 'amux-v22-recovery-controller' AND
       a."metadata"->>'requestDigest' = NEW."requestDigest" AND
       a."metadata"->>'riskAcceptanceId' = NEW."riskAcceptanceId"::text AND
       a."metadata"->>'sourceEvidenceId' = NEW."sourceEvidenceId"::text AND
       a."metadata"->>'launchBindingId' = NEW."launchBindingId"::text AND
       a."metadata"->>'launchScopeDigest' = NEW."launchScopeDigest" AND
       a."metadata"->>'workerName' = NEW."workerName" AND
       a."metadata"->>'provider' = NEW."provider" AND
       a."metadata"->>'modelId' = NEW."modelId" AND
       a."metadata"->>'routeId' = NEW."routeId" AND
       a."metadata"->>'routePolicyDigest' = NEW."routePolicyDigest" AND
       a."metadata"->>'catalogApprovalId' = NEW."catalogApprovalId" AND
       a."metadata"->>'catalogVersion' = NEW."catalogVersion" AND
       a."metadata"->>'pricingVersion' = NEW."pricingVersion" AND
       a."metadata"->>'costReceiptDigest' = NEW."costReceiptDigest" AND
       a."metadata"->>'costDigest' = NEW."costDigest" AND
       a."metadata"->>'additionalCapMicroUsd' = NEW."additionalCapMicroUsd"::text AND
       a."metadata"->>'worstExposureMicroUsd' = NEW."worstExposureMicroUsd"::text AND
       a."metadata"->>'executionStarted' = 'false' AND
       a."metadata"->>'reservationCreated' = 'false' AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Read-only launch check is not exact and trusted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22ReadOnlyLaunchCheck_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_launch_check_guard_trigger AFTER INSERT
  ON "AmuxV22ReadOnlyLaunchCheck" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_launch_check_guard();

CREATE FUNCTION amux_v22_v39_launch_proof_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c "AmuxV22ReadOnlyLaunchCheck"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "AmuxV22ReadOnlyLaunchCheck" WHERE "id" = NEW."launchCheckId";
  IF NEW."recordedAt" < c."requestedAt" OR
     NEW."report"->>'requestKind' IS DISTINCT FROM 'read_only_launch_check' OR
     NEW."report"->>'launchCheckId' IS DISTINCT FROM c."id"::text OR
     NEW."report"->>'launchProofId' IS DISTINCT FROM NEW."id"::text OR
     NEW."report"->>'requestDigest' IS DISTINCT FROM c."requestDigest" OR
     NEW."report"->>'taskId' IS DISTINCT FROM c."taskId" OR
     NEW."report"->>'priorAttemptId' IS DISTINCT FROM c."priorAttemptId" OR
     NEW."report"->>'workerName' IS DISTINCT FROM c."workerName" OR
     NEW."report"->>'workerInstanceId' IS DISTINCT FROM c."workerInstanceId" OR
     NEW."report"->>'workerGeneration' IS DISTINCT FROM c."workerGeneration"::text OR
     NEW."report"->>'riskAcceptanceId' IS DISTINCT FROM c."riskAcceptanceId"::text OR
     NEW."report"->>'launchBindingId' IS DISTINCT FROM c."launchBindingId"::text OR
     NEW."report"->>'observation' IS DISTINCT FROM NEW."observation" OR
     jsonb_typeof(NEW."report"->'launchScope') IS DISTINCT FROM 'object' OR
     NEW."report"->'launchScope' - 'launcherConfigDigest' IS DISTINCT FROM
       c."launchScope" - 'launcherConfigDigest' OR
     NEW."report"->'launchScope'->>'launcherConfigDigest' !~ '^[a-f0-9]{64}$' OR
     (NEW."verified" AND NOT EXISTS (SELECT 1 FROM "AmuxWorkerRuntime" runtime WHERE
       runtime."workerName" = c."workerName" AND runtime."instanceId" = c."workerInstanceId" AND
       runtime."generation" = c."workerGeneration")) OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE
       a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.read_only_launch_observed' AND
       a."targetType" = 'AmuxV22ReadOnlyLaunchProof' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND
       a."userAgent" IS NULL AND
       a."metadata"->>'systemActor' = 'amux-v22-recovery-controller' AND
       a."metadata"->>'launchCheckId' = c."id"::text AND
       a."metadata"->>'launchProofDigest' = NEW."proofDigest" AND
       a."metadata"->>'launchScopeDigest' ~ '^[a-f0-9]{64}$' AND
       a."metadata"->>'launcherConfigDigest' =
         NEW."report"->'launchScope'->>'launcherConfigDigest' AND
       a."metadata"->>'verified' = NEW."verified"::text AND
       a."metadata"->>'executionStarted' = 'false' AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Read-only launch proof is not exact and trusted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22ReadOnlyLaunchProof_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_launch_proof_guard_trigger AFTER INSERT
  ON "AmuxV22ReadOnlyLaunchProof" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_launch_proof_guard();

CREATE FUNCTION amux_v22_v39_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE risk "AmuxV22TaskRecoveryRiskAcceptance"%ROWTYPE;
 p "AmuxV22ReadOnlyLaunchProof"%ROWTYPE; c "AmuxV22ReadOnlyLaunchCheck"%ROWTYPE;
 db_now TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF NEW."riskAcceptanceId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO risk FROM "AmuxV22TaskRecoveryRiskAcceptance" WHERE "id" = NEW."riskAcceptanceId";
  SELECT * INTO p FROM "AmuxV22ReadOnlyLaunchProof" WHERE "id" = NEW."launchProofId";
  SELECT * INTO c FROM "AmuxV22ReadOnlyLaunchCheck" WHERE "id" = p."launchCheckId";
  IF risk."acceptanceDigest" IS DISTINCT FROM NEW."riskAcceptanceDigest" OR
     risk."taskId" IS DISTINCT FROM NEW."taskId" OR
     risk."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
     risk."launchBindingId" IS DISTINCT FROM NEW."launchBindingId" OR
     p."verified" IS DISTINCT FROM true OR p."proofDigest" IS DISTINCT FROM NEW."launchProofDigest" OR
     p."recordedAt" > db_now OR db_now - p."recordedAt" > INTERVAL '90 seconds' OR
     c."riskAcceptanceId" IS DISTINCT FROM risk."id" OR
     c."sourceEvidenceId" IS DISTINCT FROM NEW."evidenceId" OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" proof_audit WHERE
       proof_audit."id" = p."authorizationAuditLogId" AND
       proof_audit."metadata"->>'launchScopeDigest' = NEW."launchScopeDigest" AND
       proof_audit."metadata"->>'launcherConfigDigest' =
         p."report"->'launchScope'->>'launcherConfigDigest') OR
     c."workerName" IS DISTINCT FROM NEW."workerName" OR
     c."provider" IS DISTINCT FROM NEW."provider" OR c."modelId" IS DISTINCT FROM NEW."modelId" OR
     c."routeId" IS DISTINCT FROM NEW."routeId" OR
     c."routePolicyDigest" IS DISTINCT FROM NEW."routePolicyDigest" OR
     c."briefDigest" IS DISTINCT FROM NEW."briefDigest" OR
     c."catalogApprovalId" IS DISTINCT FROM NEW."catalogApprovalId" OR
     c."catalogVersion" IS DISTINCT FROM NEW."catalogVersion" OR
     c."pricingVersion" IS DISTINCT FROM NEW."pricingVersion" OR
     c."costReceiptDigest" IS DISTINCT FROM NEW."costReceiptDigest" OR
     c."costDigest" IS DISTINCT FROM NEW."costDigest" OR
     c."additionalCapMicroUsd" IS DISTINCT FROM NEW."additionalCapMicroUsd" OR
     c."worstExposureMicroUsd" IS DISTINCT FROM NEW."worstExposureMicroUsd" OR
     p."report"->'launchScope'->>'profileConfigDigest' IS DISTINCT FROM
       NEW."profileConfigDigest" OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE
       a."id" = NEW."authorizationAuditLogId" AND
       a."metadata"->>'riskAcceptanceId' = NEW."riskAcceptanceId"::text AND
       a."metadata"->>'riskAcceptanceDigest' = NEW."riskAcceptanceDigest" AND
       a."metadata"->>'launchProofId' = NEW."launchProofId"::text AND
       a."metadata"->>'launchProofDigest' = NEW."launchProofDigest" AND
       a."metadata"->>'launchBindingId' = NEW."launchBindingId"::text AND
       a."metadata"->>'launchScopeDigest' = NEW."launchScopeDigest" AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'FIRST Task final retry consent is not exact and current'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryApproval_v39_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_approval_guard_trigger AFTER INSERT
  ON "AmuxV22TaskRecoveryApproval" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_approval_guard();

CREATE FUNCTION amux_v22_v39_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a "AmuxV22TaskRecoveryApproval"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "AmuxV22TaskRecoveryApproval" WHERE "id" = NEW."recoveryApprovalId";
  IF a."riskAcceptanceId" IS NOT NULL AND
     (a."workerName" IS DISTINCT FROM NEW."workerName" OR
      a."provider" IS DISTINCT FROM NEW."provider" OR
      a."modelId" IS DISTINCT FROM NEW."modelId" OR
      a."routeId" IS DISTINCT FROM NEW."routeId" OR
      a."routePolicyDigest" IS DISTINCT FROM NEW."routePolicyDigest" OR
      a."catalogApprovalId" IS DISTINCT FROM NEW."catalogApprovalId" OR
      a."catalogVersion" IS DISTINCT FROM NEW."catalogVersion" OR
      a."costReceiptDigest" IS DISTINCT FROM NEW."costReceiptDigest" OR
      a."additionalCapMicroUsd" IS DISTINCT FROM NEW."perAttemptMicroUsd") THEN
    RAISE EXCEPTION 'Read-only retry assignment changed the final consent binding'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAssignment_v39_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_assignment_guard_trigger AFTER INSERT
  ON "AmuxV22WorkerAssignment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_assignment_guard();

CREATE FUNCTION amux_v22_v39_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a "AmuxV22TaskRecoveryApproval"%ROWTYPE; assignment "AmuxV22WorkerAssignment"%ROWTYPE;
BEGIN
  IF NEW."v22AssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment" WHERE "id" = NEW."v22AssignmentId";
  IF assignment."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "AmuxV22TaskRecoveryApproval" WHERE "id" = assignment."recoveryApprovalId";
  IF a."riskAcceptanceId" IS NOT NULL AND
     (NEW."taskId" IS DISTINCT FROM a."taskId" OR NEW."attemptNumber" IS DISTINCT FROM 2 OR
      NEW."reservedCostMicrousd" IS DISTINCT FROM a."additionalCapMicroUsd" OR
      (SELECT count(*) FROM "AmuxExecutionAttempt" x WHERE x."taskId" = NEW."taskId") > 2) THEN
    RAISE EXCEPTION 'FIRST Task permits exactly one additional capped attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAttempt_v39_limit_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_v39_attempt_guard_trigger AFTER INSERT
  ON "AmuxExecutionAttempt" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v22_v39_attempt_guard();

COMMIT;
