-- Owner decision 2026-10-30: a test Task runs as an implement execution and
-- writes in its worktree, so verified stop evidence for it must prove the
-- workspace clean, as it must for an implement Task. This replaces the v22
-- recovery evidence guard body only at that one condition. No table,
-- constraint or row changes.
-- baseline-check: replace-function-if-body-sha256 "amux_v22_recovery_evidence_guard" "ac28b17d3d3a4560b1fa6028d6c1a9d59205a92f223bc2187a5526119a776b96"
BEGIN;

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
           WHERE w."id" = r."taskId" AND w."taskRole" IN ('implement', 'test') AND
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

COMMIT;
