-- Policy v37. Additive legacy safe-stop contract only; no backfill or activation.
BEGIN;

ALTER TABLE "AmuxV22TaskRecoveryInspectionRequest"
  ADD COLUMN "requestKind" TEXT NOT NULL DEFAULT 'inspect',
  ADD COLUMN "sourceEvidenceId" UUID,
  ADD COLUMN "sourceEvidenceDigest" TEXT,
  ADD COLUMN "workerProfileAlias" TEXT,
  ADD COLUMN "profileWorkerNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "targetUnit" TEXT,
  ADD COLUMN "profileConfigDigest" TEXT,
  ADD CONSTRAINT "AmuxV22RecoveryRequest_sourceEvidenceId_fkey"
    FOREIGN KEY ("sourceEvidenceId") REFERENCES "AmuxV22TaskRecoveryEvidence"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxV22LegacySafeStopRequest_shape_check" CHECK (
    ("requestKind" = 'inspect' AND "sourceEvidenceId" IS NULL AND
      "sourceEvidenceDigest" IS NULL AND "workerProfileAlias" IS NULL AND
      cardinality("profileWorkerNames") = 0 AND "targetUnit" IS NULL AND
      "profileConfigDigest" IS NULL) OR
    ("requestKind" = 'safe_stop' AND "sourceEvidenceId" IS NOT NULL AND
      "sourceEvidenceDigest" ~ '^[a-f0-9]{64}$' AND
      "workerProfileAlias" ~ '^[a-z0-9][a-z0-9-]{0,63}$' AND
      cardinality("profileWorkerNames") BETWEEN 1 AND 16 AND
      "targetUnit" = 'tomverse-amux-v22-sidecar@' || "workerProfileAlias" || '.service' AND
      "profileConfigDigest" ~ '^[a-f0-9]{64}$'));
CREATE INDEX "AmuxV22RecoveryRequest_requestKind_requestedAt_idx"
  ON "AmuxV22TaskRecoveryInspectionRequest"("requestKind", "requestedAt");
CREATE INDEX "AmuxV22RecoveryRequest_profileWorkerNames_idx"
  ON "AmuxV22TaskRecoveryInspectionRequest" USING GIN ("profileWorkerNames");

ALTER TABLE "AmuxV22TaskRecoveryEvidence"
  ADD COLUMN "requestKind" TEXT NOT NULL DEFAULT 'inspect',
  ADD COLUMN "sourceEvidenceId" UUID,
  ADD COLUMN "sourceEvidenceDigest" TEXT,
  ADD COLUMN "stopJournalBindingDigest" TEXT,
  ADD COLUMN "stopJournalEntryDigest" TEXT,
  ADD COLUMN "stopAcknowledgement" TEXT,
  ADD COLUMN "processState" TEXT,
  ADD CONSTRAINT "AmuxV22RecoveryEvidence_sourceEvidenceId_fkey"
    FOREIGN KEY ("sourceEvidenceId") REFERENCES "AmuxV22TaskRecoveryEvidence"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxV22TaskRecoveryEvidence"
  DROP CONSTRAINT "AmuxV22RecoveryEvidence_shape_check";
ALTER TABLE "AmuxV22TaskRecoveryEvidence"
  ADD CONSTRAINT "AmuxV22RecoveryEvidence_shape_check" CHECK (
    "requestKind" IN ('inspect', 'safe_stop') AND
    ("hostInvocationId" IS NULL OR "hostInvocationId" ~ '^[a-f0-9]{32}$') AND
    "evidenceDigest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("report") = 'object' AND
    pg_column_size("report") <= 4096 AND
    (("requestKind" = 'inspect' AND "sourceEvidenceId" IS NULL AND
      "sourceEvidenceDigest" IS NULL AND "stopJournalBindingDigest" IS NULL AND
      "stopJournalEntryDigest" IS NULL AND "stopAcknowledgement" IS NULL AND
      "processState" IS NULL AND
      (("verified" AND "reason" IS NULL AND "hostInvocationId" IS NOT NULL) OR
       (NOT "verified" AND "reason" IN ('terminal_success', 'legacy_invocation_unbound',
        'inspection_unverified', 'external_effects_unknown', 'workspace_unverified',
        'recovery_identity_changed', 'runtime_observation_unverified')))) OR
     ("requestKind" = 'safe_stop' AND "sourceEvidenceId" IS NOT NULL AND
      "sourceEvidenceDigest" ~ '^[a-f0-9]{64}$' AND "hostInvocationId" IS NULL AND
      "stopJournalBindingDigest" ~ '^[a-f0-9]{64}$' AND
      "stopJournalEntryDigest" ~ '^[a-f0-9]{64}$' AND
      "stopAcknowledgement" IN ('acknowledged', 'outcome_unknown', 'not_issued') AND
      "processState" IN ('gone', 'present', 'unknown') AND
      (("verified" AND "reason" IS NULL AND "processState" = 'gone') OR
       (NOT "verified" AND "reason" IN ('safe_stop_identity_changed',
        'safe_stop_config_unverified', 'safe_stop_profile_not_unique',
        'safe_stop_other_work_present', 'safe_stop_journal_unverified',
        'safe_stop_process_present', 'safe_stop_process_unknown',
        'safe_stop_kernel_proof_stale'))))));

CREATE OR REPLACE FUNCTION amux_v22_recovery_inspection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  w "AmuxWorkItem"%ROWTYPE;
  p "AmuxExecutionAttempt"%ROWTYPE;
  source_e "AmuxV22TaskRecoveryEvidence"%ROWTYPE;
  source_r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
  request_action TEXT;
BEGIN
  IF NEW."requestKind" = 'safe_stop' THEN
    -- Claim/start take this lock before their runtime row. The deferred request
    -- guard takes the same order, so a request and a legacy writer cannot both win.
    PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
    PERFORM 1 FROM "AmuxWorkerRuntime"
      WHERE "workerName" = ANY(NEW."profileWorkerNames")
      ORDER BY "workerName" FOR UPDATE;
  END IF;

  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT * INTO p FROM "AmuxExecutionAttempt" WHERE "id" = NEW."priorAttemptId";
  request_action := CASE NEW."requestKind"
    WHEN 'inspect' THEN 'amux.v22.recovery.requested'
    WHEN 'safe_stop' THEN 'amux.v22.recovery.safe_stop_requested'
    ELSE NULL END;

  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     w."cardType" IS DISTINCT FROM 'task' OR w."status" IS DISTINCT FROM 'blocked' OR
     w."revision" IS DISTINCT FROM NEW."taskRevision" OR w."owner" IS NOT NULL OR
     w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     p."taskId" IS DISTINCT FROM NEW."taskId" OR p."worker" IS DISTINCT FROM NEW."workerName" OR
     p."taskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
     p."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     p."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR p."endedAt" IS NULL OR
     NOT (p."outcome" IN ('expired', 'outcome_unknown') OR
       p."reason" IN ('outcome_unknown', 'usage_outcome_unknown')) OR
     EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a
       WHERE a."taskId" = p."taskId" AND a."taskRevision" > p."taskRevision") OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
       WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = request_action AND
       a."targetType" = 'AmuxV22TaskRecoveryInspectionRequest' AND
       a."targetId" = NEW."id"::text AND a."actorUserId" = NEW."requestedByUserId" AND
       NOT (a."metadata" ? 'systemActor') AND
       ((NEW."requestKind" = 'inspect' AND
          coalesce(a."metadata"->>'requestKind', 'inspect') = 'inspect') OR
        (NEW."requestKind" = 'safe_stop' AND
          a."metadata"->>'requestKind' = 'safe_stop')) AND
       a."metadata"->>'requestDigest' = NEW."requestDigest" AND
       a."metadata"->>'taskId' = NEW."taskId" AND
       a."metadata"->>'priorAttemptId' = NEW."priorAttemptId" AND
       (NEW."requestKind" = 'inspect' OR
        (a."metadata"->>'sourceEvidenceId' = NEW."sourceEvidenceId"::text AND
         a."metadata"->>'sourceEvidenceDigest' = NEW."sourceEvidenceDigest" AND
         a."metadata"->>'workerProfileAlias' = NEW."workerProfileAlias" AND
         a."metadata"->>'profileConfigDigest' = NEW."profileConfigDigest" AND
         a."metadata"->>'targetUnit' = NEW."targetUnit")) AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery request is not exact and human audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryInspection_binding_check';
  END IF;

  IF NEW."requestKind" = 'safe_stop' THEN
    SELECT * INTO source_e FROM "AmuxV22TaskRecoveryEvidence"
      WHERE "id" = NEW."sourceEvidenceId";
    SELECT * INTO source_r FROM "AmuxV22TaskRecoveryInspectionRequest"
      WHERE "id" = source_e."inspectionId";
    IF w."taskRole" IS DISTINCT FROM 'investigate' OR
       source_e."id" IS NULL OR source_e."evidenceDigest" IS DISTINCT FROM NEW."sourceEvidenceDigest" OR
       source_r."taskId" IS DISTINCT FROM NEW."taskId" OR
       source_r."taskRevision" IS DISTINCT FROM NEW."taskRevision" OR
       source_r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
       source_r."priorAttemptTaskRevision" IS DISTINCT FROM NEW."priorAttemptTaskRevision" OR
       source_r."workerName" IS DISTINCT FROM NEW."workerName" OR
       source_r."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
       source_r."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
       source_r."targetHost" IS DISTINCT FROM NEW."targetHost" OR
       NOT ((source_r."requestKind" = 'inspect' AND source_e."requestKind" = 'inspect' AND
         source_e."verified" = false AND source_e."reason" = 'legacy_invocation_unbound' AND
         source_e."report"->'proof'->'externalEffectsKnown' = 'true'::jsonb AND
         source_e."report"->'proof'->>'terminalOutcome' <> 'succeeded') OR
        (source_r."requestKind" = 'safe_stop' AND source_e."requestKind" = 'safe_stop' AND
         source_r."workerProfileAlias" = NEW."workerProfileAlias" AND
         source_r."profileWorkerNames" = NEW."profileWorkerNames" AND
         source_r."targetUnit" = NEW."targetUnit" AND
         source_r."profileConfigDigest" = NEW."profileConfigDigest")) OR
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
       EXISTS (SELECT 1 FROM "AmuxWorkItem" other
         WHERE other."id" <> NEW."taskId" AND other."archivedAt" IS NULL AND
           other."status" NOT IN ('done', 'cancelled') AND
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
            attempt."reason" IN ('outcome_unknown', 'usage_outcome_unknown'))) OR
       EXISTS (SELECT 1 FROM "AmuxWorkDelivery" delivery
         WHERE delivery."worker" = ANY(NEW."profileWorkerNames") AND
           delivery."status" IN ('queued', 'leased')) THEN
      RAISE EXCEPTION 'Legacy safe-stop request is not a read-only, idle physical profile'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_request_guard_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION amux_v22_recovery_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
  b JSONB;
  p JSONB;
  u JSONB;
BEGIN
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = NEW."inspectionId";
  b := NEW."report";
  u := b->'usage';

  IF NEW."requestKind" IS DISTINCT FROM r."requestKind" OR
     NEW."sourceEvidenceId" IS DISTINCT FROM r."sourceEvidenceId" OR
     NEW."sourceEvidenceDigest" IS DISTINCT FROM r."sourceEvidenceDigest" OR
     jsonb_typeof(u) IS DISTINCT FROM 'object' OR
     (SELECT count(*) FROM jsonb_object_keys(u)) <> 2 OR
     NOT (u - ARRAY['status','projectedCostMicroUsd']) = '{}'::jsonb OR
     u->>'status' IS NULL OR u->>'status' NOT IN ('unknown','reported_complete') OR
     (u->>'status' = 'unknown' AND u->'projectedCostMicroUsd' <> 'null'::jsonb) OR
     (u->'projectedCostMicroUsd' <> 'null'::jsonb AND
       NOT (u->>'projectedCostMicroUsd' ~ '^(0|[1-9][0-9]{0,18})$')) OR
     NEW."recordedAt" < r."requestedAt" THEN
    RAISE EXCEPTION 'Recovery evidence common binding is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryEvidence_binding_check';
  END IF;

  IF NEW."requestKind" = 'inspect' THEN
    p := b->'proof';
    IF (SELECT count(*) FROM jsonb_object_keys(b)) <> 15 OR
       NOT (b - ARRAY['inspectionId','evidenceId','requestDigest','taskId','taskRevision',
         'priorAttemptId','priorAttemptTaskRevision','workerName','workerInstanceId','workerGeneration','targetHost',
         'hostInvocationId','proof','usage','reason']) = '{}'::jsonb OR
       jsonb_typeof(p) IS DISTINCT FROM 'object' OR
       (SELECT count(*) FROM jsonb_object_keys(p)) <> 10 OR
       NOT (p - ARRAY['terminalOutcome','sameLiveInvocation','noActiveExecution','processTreeStopped',
         'rootOwnedUnit','controlGroupBound','journalBound','socketTerminal','externalEffectsKnown','workspaceClean']) = '{}'::jsonb OR
       b->>'inspectionId' IS DISTINCT FROM r."id"::text OR
       b->>'evidenceId' IS DISTINCT FROM NEW."id"::text OR
       b->>'requestDigest' IS DISTINCT FROM r."requestDigest" OR
       b->>'taskId' IS DISTINCT FROM r."taskId" OR
       b->>'taskRevision' IS DISTINCT FROM r."taskRevision"::text OR
       b->>'priorAttemptId' IS DISTINCT FROM r."priorAttemptId" OR
       b->>'priorAttemptTaskRevision' IS DISTINCT FROM r."priorAttemptTaskRevision"::text OR
       b->>'workerName' IS DISTINCT FROM r."workerName" OR
       b->>'workerInstanceId' IS DISTINCT FROM r."workerInstanceId" OR
       b->>'workerGeneration' IS DISTINCT FROM r."workerGeneration"::text OR
       b->>'targetHost' IS DISTINCT FROM r."targetHost" OR
       b->>'hostInvocationId' IS DISTINCT FROM NEW."hostInvocationId" OR
       p->>'terminalOutcome' IS NULL OR
       p->>'terminalOutcome' NOT IN ('succeeded','failed','blocked','unknown') OR
       b->>'reason' IS NULL OR
       b->>'reason' NOT IN ('stopped_proven','legacy_invocation_unbound','inspection_unverified','terminal_success') OR
       EXISTS (SELECT 1 FROM jsonb_each(p) kv
         WHERE kv.key <> 'terminalOutcome' AND jsonb_typeof(kv.value) <> 'boolean') OR
       (NEW."verified" AND (p->>'terminalOutcome' = 'succeeded' OR
         b->>'reason' <> 'stopped_proven' OR
         EXISTS (SELECT 1 FROM jsonb_each(p) kv
           WHERE kv.key NOT IN ('terminalOutcome','workspaceClean') AND kv.value <> 'true'::jsonb) OR
         EXISTS (SELECT 1 FROM "AmuxWorkItem" w
           WHERE w."id" = r."taskId" AND w."taskRole" = 'implement' AND
             p->'workspaceClean' <> 'true'::jsonb))) OR
       NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
         WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
         a."action" = 'amux.v22.recovery.inspected' AND
         a."targetType" = 'AmuxV22TaskRecoveryEvidence' AND a."targetId" = NEW."id"::text AND
         a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND
         a."userAgent" IS NULL AND a."metadata"->>'systemActor' = 'amux-v22-recovery-checker' AND
         a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND
         a."metadata"->>'inspectionId' = r."id"::text AND
         a.xmin = pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'Recovery inspection evidence is not content-free and bound'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryEvidence_binding_check';
    END IF;
  ELSIF NEW."requestKind" = 'safe_stop' THEN
    p := b->'stopProof';
    IF (SELECT count(*) FROM jsonb_object_keys(b)) <> 23 OR
       NOT (b - ARRAY['inspectionId','evidenceId','requestKind','requestDigest','taskId','taskRevision',
         'priorAttemptId','priorAttemptTaskRevision','workerName','workerInstanceId','workerGeneration','targetHost',
         'sourceEvidenceId','sourceEvidenceDigest','workerProfileAlias','profileWorkerNames','targetUnit',
         'profileConfigDigest','hostInvocationId','modelOutcome','stopProof','usage','reason']) = '{}'::jsonb OR
       jsonb_typeof(p) IS DISTINCT FROM 'object' OR
       (SELECT count(*) FROM jsonb_object_keys(p)) <> 14 OR
       NOT (p - ARRAY['journalBindingDigest','journalEntryDigest','journalDisposition','stopAcknowledgement',
         'processState','fixedUnit','rootOwnedConfig','profileUnique','noOtherWork','restartDisabled',
         'journalBound','mainPidAbsent','controlGroupEmpty','kernelProofFresh']) = '{}'::jsonb OR
       b->>'inspectionId' IS DISTINCT FROM r."id"::text OR
       b->>'evidenceId' IS DISTINCT FROM NEW."id"::text OR
       b->>'requestKind' IS DISTINCT FROM 'safe_stop' OR
       b->>'requestDigest' IS DISTINCT FROM r."requestDigest" OR
       b->>'taskId' IS DISTINCT FROM r."taskId" OR
       b->>'taskRevision' IS DISTINCT FROM r."taskRevision"::text OR
       b->>'priorAttemptId' IS DISTINCT FROM r."priorAttemptId" OR
       b->>'priorAttemptTaskRevision' IS DISTINCT FROM r."priorAttemptTaskRevision"::text OR
       b->>'workerName' IS DISTINCT FROM r."workerName" OR
       b->>'workerInstanceId' IS DISTINCT FROM r."workerInstanceId" OR
       b->>'workerGeneration' IS DISTINCT FROM r."workerGeneration"::text OR
       b->>'targetHost' IS DISTINCT FROM r."targetHost" OR
       b->>'sourceEvidenceId' IS DISTINCT FROM r."sourceEvidenceId"::text OR
       b->>'sourceEvidenceDigest' IS DISTINCT FROM r."sourceEvidenceDigest" OR
       b->>'workerProfileAlias' IS DISTINCT FROM r."workerProfileAlias" OR
       b->'profileWorkerNames' IS DISTINCT FROM to_jsonb(r."profileWorkerNames") OR
       b->>'targetUnit' IS DISTINCT FROM r."targetUnit" OR
       b->>'profileConfigDigest' IS DISTINCT FROM r."profileConfigDigest" OR
       b->'hostInvocationId' <> 'null'::jsonb OR
       b->>'modelOutcome' IS DISTINCT FROM 'unknown' OR
       u->>'status' IS DISTINCT FROM 'unknown' OR u->'projectedCostMicroUsd' <> 'null'::jsonb OR
       p->>'journalBindingDigest' IS DISTINCT FROM NEW."stopJournalBindingDigest" OR
       p->>'journalEntryDigest' IS DISTINCT FROM NEW."stopJournalEntryDigest" OR
       p->>'stopAcknowledgement' IS DISTINCT FROM NEW."stopAcknowledgement" OR
       p->>'processState' IS DISTINCT FROM NEW."processState" OR
       p->>'journalDisposition' IS NULL OR
       p->>'journalDisposition' NOT IN ('intent_recorded','intent_reused','not_needed_already_gone') OR
       NOT ((p->>'journalDisposition' = 'not_needed_already_gone' AND
          p->>'stopAcknowledgement' = 'not_issued') OR
         (p->>'journalDisposition' IN ('intent_recorded','intent_reused') AND
          p->>'stopAcknowledgement' IN ('acknowledged','outcome_unknown'))) OR
       EXISTS (SELECT 1 FROM jsonb_each(p) kv
         WHERE kv.key NOT IN ('journalBindingDigest','journalEntryDigest','journalDisposition',
           'stopAcknowledgement','processState') AND jsonb_typeof(kv.value) <> 'boolean') OR
       b->>'reason' IS NULL OR
       b->>'reason' NOT IN ('safe_stop_process_gone','safe_stop_identity_changed',
         'safe_stop_config_unverified','safe_stop_profile_not_unique','safe_stop_other_work_present',
         'safe_stop_journal_unverified','safe_stop_process_present','safe_stop_process_unknown',
         'safe_stop_kernel_proof_stale') OR
       (NEW."verified" AND (b->>'reason' IS DISTINCT FROM 'safe_stop_process_gone' OR
         p->>'processState' IS DISTINCT FROM 'gone' OR
         EXISTS (SELECT 1 FROM jsonb_each(p) kv
           WHERE kv.key IN ('fixedUnit','rootOwnedConfig','profileUnique','noOtherWork',
             'restartDisabled','journalBound','mainPidAbsent','controlGroupEmpty','kernelProofFresh') AND
             kv.value <> 'true'::jsonb))) OR
       (NOT NEW."verified" AND NEW."reason" IS DISTINCT FROM b->>'reason') OR
       NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
         WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
         a."action" = 'amux.v22.recovery.safe_stop_reported' AND
         a."targetType" = 'AmuxV22TaskRecoveryEvidence' AND a."targetId" = NEW."id"::text AND
         a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND
         a."userAgent" IS NULL AND
         a."metadata"->>'systemActor' = 'amux-v22-recovery-controller' AND
         a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND
         a."metadata"->>'inspectionId' = r."id"::text AND
         a."metadata"->>'stopJournalBindingDigest' = NEW."stopJournalBindingDigest" AND
         a."metadata"->>'stopJournalEntryDigest' = NEW."stopJournalEntryDigest" AND
         a."metadata"->>'stopAcknowledgement' = NEW."stopAcknowledgement" AND
         a."metadata"->>'processState' = NEW."processState" AND
         a.xmin = pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'Legacy safe-stop evidence is not content-free and bound'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStopEvidence_binding_check';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown recovery evidence kind'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryEvidence_binding_check';
  END IF;
  RETURN NEW;
END $$;

-- A safe-stop request fences every epoch of every physical-profile member.
-- V37 has no resume writer: process-gone evidence and re-registration never
-- release this row. Another eligible worker may claim the recovered Task.
CREATE FUNCTION amux_v22_legacy_safe_stop_worker_fenced(worker_name TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AmuxV22TaskRecoveryInspectionRequest" request
    WHERE request."requestKind" = 'safe_stop'
      AND request."profileWorkerNames" @> ARRAY[worker_name]::TEXT[]
  );
$$;

CREATE FUNCTION amux_v22_legacy_safe_stop_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
  IF amux_v22_legacy_safe_stop_worker_fenced(NEW."workerName") THEN
    RAISE EXCEPTION 'Physical worker is fenced by a legacy safe-stop request'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_worker_fenced_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_legacy_safe_stop_assignment_guard_trigger BEFORE INSERT
  ON "AmuxV22WorkerAssignment" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_legacy_safe_stop_assignment_guard();

CREATE FUNCTION amux_v22_legacy_safe_stop_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
  IF amux_v22_legacy_safe_stop_worker_fenced(NEW."worker") THEN
    RAISE EXCEPTION 'Physical worker is fenced by a legacy safe-stop request'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_worker_fenced_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_legacy_safe_stop_attempt_guard_trigger BEFORE INSERT
  ON "AmuxExecutionAttempt" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_legacy_safe_stop_attempt_guard();

CREATE FUNCTION amux_v22_legacy_safe_stop_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."status" <> 'leased' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
  -- INSERT is always new work. UPDATE blocks only a lease/re-lease; ACK and
  -- cancellation remain available so an already-issued receipt can settle.
  IF amux_v22_legacy_safe_stop_worker_fenced(NEW."worker") AND
     (TG_OP = 'INSERT' OR NEW."status" = 'leased') THEN
    RAISE EXCEPTION 'Physical worker is fenced by a legacy safe-stop request'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_worker_fenced_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_legacy_safe_stop_delivery_guard_trigger BEFORE INSERT
  ON "AmuxWorkDelivery" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_legacy_safe_stop_delivery_guard();
CREATE TRIGGER amux_v22_legacy_safe_stop_delivery_lease_guard_trigger
  BEFORE UPDATE OF "worker", "status", "receiptId", "leasedAt", "leaseExpiresAt"
  ON "AmuxWorkDelivery" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_legacy_safe_stop_delivery_guard();

-- A rolling old claimer can mutate an existing Task without inserting an
-- assignment. Block acquisition and execution transitions for a permanently
-- fenced physical worker while allowing owner-clearing terminal cleanup.
CREATE FUNCTION amux_v22_legacy_safe_stop_task_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."owner" IS NULL OR NOT
     (NEW."owner" IS DISTINCT FROM OLD."owner" OR
      NEW."v22AssignmentId" IS DISTINCT FROM OLD."v22AssignmentId" OR
      (NEW."status" IS DISTINCT FROM OLD."status" AND
       NEW."status" IN ('todo', 'doing', 'review'))) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-amux-admission'));
  IF amux_v22_legacy_safe_stop_worker_fenced(NEW."owner") THEN
    RAISE EXCEPTION 'Physical worker is fenced from Task acquisition or execution'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LegacySafeStop_worker_fenced_check';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amux_v22_legacy_safe_stop_task_guard_trigger
  BEFORE UPDATE OF "owner", "status", "v22AssignmentId"
  ON "AmuxWorkItem" FOR EACH ROW
  EXECUTE FUNCTION amux_v22_legacy_safe_stop_task_guard();

COMMIT;
