-- Policy v36. Additive metadata-only recovery authority; no backfill or activation.
BEGIN;
CREATE TABLE "AmuxV22TaskRecoveryInspectionRequest" (
  "id" UUID PRIMARY KEY, "ownerRequestId" UUID NOT NULL UNIQUE,
  "taskId" TEXT NOT NULL REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskRevision" INTEGER NOT NULL,
  "priorAttemptId" TEXT NOT NULL REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "priorAttemptTaskRevision" INTEGER NOT NULL,
  "workerName" TEXT NOT NULL, "workerInstanceId" TEXT NOT NULL, "workerGeneration" INTEGER NOT NULL,
  "targetHost" TEXT NOT NULL, "requestDigest" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RecoveryInspection_shape_check" CHECK (
    "taskRevision" BETWEEN 0 AND 2147483644 AND
    "priorAttemptTaskRevision" BETWEEN 0 AND 2147483647 AND "workerGeneration" > 0 AND
    length("workerName") BETWEEN 1 AND 128 AND
    "workerInstanceId" ~ '^[a-f0-9-]{36}$' AND "targetHost" = 'amux-ubuntu' AND
    "requestDigest" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "AmuxV22TaskRecoveryInspectionRequest_workerName_requestedAt_idx"
 ON "AmuxV22TaskRecoveryInspectionRequest"("workerName", "requestedAt");
CREATE INDEX "AmuxV22TaskRecoveryInspectionRequest_taskId_requestedAt_idx"
 ON "AmuxV22TaskRecoveryInspectionRequest"("taskId", "requestedAt");

CREATE TABLE "AmuxV22TaskRecoveryEvidence" (
  "id" UUID PRIMARY KEY,
  "inspectionId" UUID NOT NULL UNIQUE REFERENCES "AmuxV22TaskRecoveryInspectionRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "hostInvocationId" TEXT, "report" JSONB NOT NULL, "evidenceDigest" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL, "reason" TEXT,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RecoveryEvidence_shape_check" CHECK (
    ("hostInvocationId" IS NULL OR "hostInvocationId" ~ '^[a-f0-9]{32}$') AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("report") = 'object' AND
    pg_column_size("report") <= 4096 AND
    (("verified" AND "reason" IS NULL AND "hostInvocationId" IS NOT NULL) OR
     (NOT "verified" AND "reason" IN ('terminal_success', 'legacy_invocation_unbound',
      'inspection_unverified', 'external_effects_unknown', 'workspace_unverified',
      'recovery_identity_changed', 'runtime_observation_unverified'))))
);
CREATE TABLE "AmuxV22TaskRecoveryApproval" (
  "id" UUID PRIMARY KEY, "ownerRequestId" UUID NOT NULL UNIQUE,
  "inspectionId" UUID NOT NULL UNIQUE REFERENCES "AmuxV22TaskRecoveryInspectionRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL UNIQUE REFERENCES "AmuxV22TaskRecoveryEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskId" TEXT NOT NULL, "beforeRevision" INTEGER NOT NULL, "afterRevision" INTEGER NOT NULL,
  "priorAttemptId" TEXT NOT NULL, "evidenceDigest" TEXT NOT NULL, "costDigest" TEXT NOT NULL,
  "catalogApprovalId" TEXT NOT NULL, "catalogVersion" TEXT NOT NULL, "pricingVersion" TEXT NOT NULL,
  "costReceiptDigest" TEXT NOT NULL, "costReceipt" JSONB NOT NULL,
  "historicalAttempts" INTEGER NOT NULL, "nextAttemptNumber" INTEGER NOT NULL,
  "oldHeldMicroUsd" BIGINT NOT NULL, "additionalCapMicroUsd" BIGINT NOT NULL,
  "worstExposureMicroUsd" BIGINT NOT NULL, "approvedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RecoveryApproval_shape_check" CHECK (
    "beforeRevision" BETWEEN 0 AND 2147483644 AND "afterRevision" = "beforeRevision" + 1 AND
    "historicalAttempts" > 0 AND "nextAttemptNumber" > "historicalAttempts" AND
    "nextAttemptNumber" BETWEEN 1 AND 5 AND
    "oldHeldMicroUsd" > 0 AND "additionalCapMicroUsd" > 0 AND
    "worstExposureMicroUsd" = "oldHeldMicroUsd" + "additionalCapMicroUsd" AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$' AND "costDigest" ~ '^[a-f0-9]{64}$' AND
    "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("costReceipt") = 'object')
);
CREATE INDEX "AmuxV22TaskRecoveryApproval_taskId_afterRevision_idx"
 ON "AmuxV22TaskRecoveryApproval"("taskId", "afterRevision");
ALTER TABLE "AmuxV22WorkerAssignment" ADD COLUMN "recoveryApprovalId" UUID UNIQUE
 REFERENCES "AmuxV22TaskRecoveryApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_v22_recovery_evidence_db_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."recordedAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_recovery_evidence_db_clock_trigger BEFORE INSERT
 ON "AmuxV22TaskRecoveryEvidence" FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_evidence_db_clock();

CREATE FUNCTION amux_v22_recovery_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Task recovery metadata is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22Recovery_append_only_check';
END $$;
CREATE TRIGGER amux_v22_recovery_inspection_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22TaskRecoveryInspectionRequest" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();
CREATE TRIGGER amux_v22_recovery_evidence_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22TaskRecoveryEvidence" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();
CREATE TRIGGER amux_v22_recovery_approval_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22TaskRecoveryApproval" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();

CREATE FUNCTION amux_v22_recovery_inspection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "AmuxWorkItem"%ROWTYPE; p "AmuxExecutionAttempt"%ROWTYPE;
BEGIN
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT * INTO p FROM "AmuxExecutionAttempt" WHERE "id" = NEW."priorAttemptId";
  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR w."cardType" IS DISTINCT FROM 'task' OR
     w."status" IS DISTINCT FROM 'blocked' OR w."revision" IS DISTINCT FROM NEW."taskRevision" OR
     w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     p."taskId" IS DISTINCT FROM NEW."taskId" OR p."worker" IS DISTINCT FROM NEW."workerName" OR
     p."taskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
     p."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     p."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR p."endedAt" IS NULL OR
     NOT (p."outcome" IN ('expired', 'outcome_unknown') OR p."reason" IN ('outcome_unknown', 'usage_outcome_unknown')) OR
     EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = p."taskId" AND a."taskRevision" > p."taskRevision") OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND
       a."entryHash" IS NOT NULL AND a."action" = 'amux.v22.recovery.requested' AND
       a."targetType" = 'AmuxV22TaskRecoveryInspectionRequest' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" = NEW."requestedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'requestDigest' = NEW."requestDigest" AND
       a."metadata"->>'taskId' = NEW."taskId" AND a."metadata"->>'priorAttemptId' = NEW."priorAttemptId" AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery inspection is not exact and human audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryInspection_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_inspection_guard_trigger AFTER INSERT
 ON "AmuxV22TaskRecoveryInspectionRequest" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_inspection_guard();

CREATE FUNCTION amux_v22_recovery_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE; b JSONB; p JSONB; u JSONB;
BEGIN
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = NEW."inspectionId";
  b := NEW."report"; p := b->'proof'; u := b->'usage';
  IF (SELECT count(*) FROM jsonb_object_keys(b)) <> 15 OR
     NOT (b - ARRAY['inspectionId','evidenceId','requestDigest','taskId','taskRevision',
       'priorAttemptId','priorAttemptTaskRevision','workerName','workerInstanceId','workerGeneration','targetHost',
       'hostInvocationId','proof','usage','reason']) = '{}'::jsonb OR
     jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(u) IS DISTINCT FROM 'object' OR
     (SELECT count(*) FROM jsonb_object_keys(p)) <> 10 OR
     NOT (p - ARRAY['terminalOutcome','sameLiveInvocation','noActiveExecution','processTreeStopped',
       'rootOwnedUnit','controlGroupBound','journalBound','socketTerminal','externalEffectsKnown','workspaceClean']) = '{}'::jsonb OR
     (SELECT count(*) FROM jsonb_object_keys(u)) <> 2 OR
     NOT (u - ARRAY['status','projectedCostMicroUsd']) = '{}'::jsonb OR
     b->>'inspectionId' IS DISTINCT FROM r."id"::text OR b->>'evidenceId' IS DISTINCT FROM NEW."id"::text OR
     b->>'requestDigest' IS DISTINCT FROM r."requestDigest" OR b->>'taskId' IS DISTINCT FROM r."taskId" OR
     b->>'taskRevision' IS DISTINCT FROM r."taskRevision"::text OR b->>'priorAttemptId' IS DISTINCT FROM r."priorAttemptId" OR
     b->>'priorAttemptTaskRevision' IS DISTINCT FROM r."priorAttemptTaskRevision"::text OR
     b->>'workerName' IS DISTINCT FROM r."workerName" OR b->>'workerInstanceId' IS DISTINCT FROM r."workerInstanceId" OR
     b->>'workerGeneration' IS DISTINCT FROM r."workerGeneration"::text OR b->>'targetHost' IS DISTINCT FROM r."targetHost" OR
     b->>'hostInvocationId' IS DISTINCT FROM NEW."hostInvocationId" OR NEW."recordedAt" < r."requestedAt" OR
     p->>'terminalOutcome' NOT IN ('succeeded','failed','blocked','unknown') OR
     b->>'reason' NOT IN ('stopped_proven','legacy_invocation_unbound','inspection_unverified','terminal_success') OR
     u->>'status' NOT IN ('unknown','reported_complete') OR
     (u->>'status' = 'unknown' AND u->'projectedCostMicroUsd' <> 'null'::jsonb) OR
     (u->'projectedCostMicroUsd' <> 'null'::jsonb AND
       NOT (u->>'projectedCostMicroUsd' ~ '^(0|[1-9][0-9]{0,18})$')) OR
     EXISTS (SELECT 1 FROM jsonb_each(p) kv WHERE kv.key <> 'terminalOutcome' AND jsonb_typeof(kv.value) <> 'boolean') OR
     (NEW."verified" AND (p->>'terminalOutcome' = 'succeeded' OR b->>'reason' <> 'stopped_proven' OR
       EXISTS (SELECT 1 FROM jsonb_each(p) kv WHERE kv.key NOT IN ('terminalOutcome','workspaceClean') AND kv.value <> 'true'::jsonb) OR
       EXISTS (SELECT 1 FROM "AmuxWorkItem" w WHERE w."id" = r."taskId" AND w."taskRole" = 'implement' AND p->'workspaceClean' <> 'true'::jsonb))) OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.inspected' AND a."targetType" = 'AmuxV22TaskRecoveryEvidence' AND
       a."targetId" = NEW."id"::text AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND
       a."metadata"->>'systemActor' = 'amux-v22-recovery-checker' AND a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND
       a."metadata"->>'inspectionId' = r."id"::text AND a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery evidence is not content-free and bound'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryEvidence_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_evidence_guard_trigger AFTER INSERT
 ON "AmuxV22TaskRecoveryEvidence" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_evidence_guard();

CREATE FUNCTION amux_v22_recovery_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE; e "AmuxV22TaskRecoveryEvidence"%ROWTYPE;
 w "AmuxWorkItem"%ROWTYPE; used INTEGER; next_number INTEGER; held BIGINT;
 db_now TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = NEW."inspectionId";
  SELECT * INTO e FROM "AmuxV22TaskRecoveryEvidence" WHERE "id" = NEW."evidenceId";
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT count(*)::integer, greatest(count(*)::integer, coalesce(max("attemptNumber"),0)) + 1,
    coalesce(sum("reservedCostMicrousd"),0) INTO used, next_number, held
    FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";
  IF r."taskId" IS DISTINCT FROM NEW."taskId" OR r."taskRevision" IS DISTINCT FROM NEW."beforeRevision" OR
     r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR r."requestedByUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
     e."inspectionId" IS DISTINCT FROM r."id" OR e."verified" IS DISTINCT FROM true OR
     e."evidenceDigest" IS DISTINCT FROM NEW."evidenceDigest" OR
     e."recordedAt" > db_now OR db_now - e."recordedAt" > INTERVAL '90 seconds' OR
     w."status" IS DISTINCT FROM 'todo' OR w."revision" IS DISTINCT FROM NEW."afterRevision" OR
     w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     used IS DISTINCT FROM NEW."historicalAttempts" OR next_number IS DISTINCT FROM NEW."nextAttemptNumber" OR held IS DISTINCT FROM NEW."oldHeldMicroUsd" OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.approved' AND a."targetType" = 'AmuxV22TaskRecoveryApproval' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" = NEW."approvedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND a."metadata"->>'costDigest' = NEW."costDigest" AND
       a."metadata"->>'oldHeldMicroUsd' = NEW."oldHeldMicroUsd"::text AND a."metadata"->>'additionalCapMicroUsd' = NEW."additionalCapMicroUsd"::text AND
       a."metadata"->>'ownerRequestId' = NEW."ownerRequestId"::text AND a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery approval is not exact and human audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryApproval_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_approval_guard_trigger AFTER INSERT
 ON "AmuxV22TaskRecoveryApproval" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_approval_guard();

CREATE FUNCTION amux_v22_recovery_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a "AmuxV22TaskRecoveryApproval"%ROWTYPE;
 audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "AmuxV22TaskRecoveryApproval" WHERE "id" = NEW."recoveryApprovalId";
  SELECT * INTO audit FROM "AdminAuditLog" WHERE "id" = NEW."authorizationAuditLogId";
  IF a."taskId" IS DISTINCT FROM NEW."workItemId" OR a."afterRevision" IS DISTINCT FROM NEW."taskRevision" OR
     a."catalogApprovalId" IS DISTINCT FROM NEW."catalogApprovalId" OR a."catalogVersion" IS DISTINCT FROM NEW."catalogVersion" OR
     NEW."perAttemptMicroUsd" <= 0 OR NEW."perAttemptMicroUsd" > a."additionalCapMicroUsd" OR
     audit."id" IS NULL OR audit."entryHash" IS NULL OR audit."action" IS DISTINCT FROM 'amux.v22.worker.assigned' OR
     audit."targetType" IS DISTINCT FROM 'AmuxV22WorkerAssignment' OR audit."targetId" IS DISTINCT FROM NEW."id"::text OR
     audit."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v22-worker-claim' OR
     audit."metadata"->>'recoveryApprovalId' IS DISTINCT FROM a."id"::text OR
     audit."metadata"->>'recoveryCostDigest' IS DISTINCT FROM a."costDigest" THEN
    RAISE EXCEPTION 'Recovery assignment does not consume its exact additional cap'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAssignment_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_assignment_guard_trigger AFTER INSERT
 ON "AmuxV22WorkerAssignment" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_assignment_guard();

CREATE FUNCTION amux_v22_recovery_old_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AmuxV22TaskRecoveryInspectionRequest" r WHERE r."priorAttemptId" = OLD."id") AND
     (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Inspected unknown attempt remains immutable and held'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22Recovery_prior_attempt_immutable_check';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_recovery_old_attempt_guard_trigger BEFORE UPDATE OR DELETE ON "AmuxExecutionAttempt"
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_old_attempt_guard();

-- The existing amux_v22_execution_attempt_guard remains unchanged, including
-- its global attemptNumber BETWEEN 1 AND 5 circuit breaker. This additive
-- guard binds the one recovery assignment to the exact approved next attempt.
CREATE FUNCTION amux_v22_recovery_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE assignment "AmuxV22WorkerAssignment"%ROWTYPE;
 recovery "AmuxV22TaskRecoveryApproval"%ROWTYPE;
 attempt_count INTEGER; held BIGINT;
BEGIN
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment" WHERE "id" = NEW."v22AssignmentId" AND "workItemId" = NEW."taskId";
  IF assignment."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM "AmuxV22TaskRecoveryApproval" WHERE "id" = assignment."recoveryApprovalId";
  SELECT count(*)::integer, coalesce(sum("reservedCostMicrousd"),0)
    INTO attempt_count, held FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";
  IF recovery."id" IS NULL OR recovery."taskId" IS DISTINCT FROM NEW."taskId" OR
     recovery."afterRevision" IS DISTINCT FROM assignment."taskRevision" OR
     recovery."nextAttemptNumber" NOT BETWEEN 1 AND 5 OR
     NEW."attemptNumber" IS DISTINCT FROM recovery."nextAttemptNumber" OR
     NEW."reservedCostMicrousd" <= 0 OR NEW."reservedCostMicrousd" > recovery."additionalCapMicroUsd" OR
     attempt_count IS DISTINCT FROM recovery."historicalAttempts" + 1 OR
     held IS DISTINCT FROM recovery."oldHeldMicroUsd" + NEW."reservedCostMicrousd" THEN
    RAISE EXCEPTION 'Recovery attempt does not consume its exact one-attempt authority'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAttempt_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_attempt_guard_trigger
 AFTER INSERT OR UPDATE ON "AmuxExecutionAttempt" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_attempt_guard();
COMMIT;
