-- baseline-check: present-if-relation "AmuxV22TaskRecoveryPreApproval"
-- Owner decision 2026-11-08: the owner cannot watch a 90-second window, so a
-- lost v22 Task run is recovered with one owner click.
--
-- 1. AmuxV22TaskRecoveryPreApproval: the owner's re-authenticated, audited
--    consent to exactly one additional capped attempt for one Task revision
--    and prior attempt, at the cost the server computed when they confirmed.
--    It is created in the same transaction as the inspection request it
--    waits on, and it expires 30 minutes later.
-- 2. AmuxV22TaskRecoveryPreApprovalResult: the one outcome of that consent,
--    applied (bound to the approval it opened) or refused with its reason.
--    It is written once, by the system, after the checker's evidence.
-- 3. AmuxV22TaskRecoveryApproval.preApprovalId: an approval opened from a
--    pre-approval names it. The approval guard accepts it in place of a
--    same-transaction human audit only when the pre-approval is exact,
--    unexpired, human audited, and the evidence was recorded after it.
-- 4. A manual inspect approval accepts evidence up to 15 minutes old (it was
--    90 seconds); the safe-stop path keeps 90 seconds.
-- No row changes. Nothing here admits, reserves or starts work.
BEGIN;

CREATE TABLE "AmuxV22TaskRecoveryPreApproval" (
  "id" UUID PRIMARY KEY, "ownerRequestId" UUID NOT NULL UNIQUE,
  "inspectionId" UUID NOT NULL UNIQUE REFERENCES "AmuxV22TaskRecoveryInspectionRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskId" TEXT NOT NULL REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "taskRevision" INTEGER NOT NULL,
  "priorAttemptId" TEXT NOT NULL REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "costDigest" TEXT NOT NULL, "catalogApprovalId" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL, "pricingVersion" TEXT NOT NULL,
  "costReceiptDigest" TEXT NOT NULL, "oldHeldMicroUsd" BIGINT NOT NULL,
  "additionalCapMicroUsd" BIGINT NOT NULL, "worstExposureMicroUsd" BIGINT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RecoveryPreApproval_shape_check" CHECK (
    "taskRevision" BETWEEN 0 AND 2147483644 AND
    "costDigest" ~ '^[a-f0-9]{64}$' AND "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND
    "oldHeldMicroUsd" >= 0 AND "additionalCapMicroUsd" > 0 AND
    "worstExposureMicroUsd" = "oldHeldMicroUsd" + "additionalCapMicroUsd" AND
    "expiresAt" = "requestedAt" + INTERVAL '30 minutes')
);
CREATE INDEX "AmuxV22TaskRecoveryPreApproval_taskId_requestedAt_idx"
 ON "AmuxV22TaskRecoveryPreApproval"("taskId", "requestedAt");

ALTER TABLE "AmuxV22TaskRecoveryApproval" ADD COLUMN "preApprovalId" UUID UNIQUE
 REFERENCES "AmuxV22TaskRecoveryPreApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxV22TaskRecoveryPreApprovalResult" (
  "id" UUID PRIMARY KEY,
  "preApprovalId" UUID NOT NULL UNIQUE REFERENCES "AmuxV22TaskRecoveryPreApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "outcome" TEXT NOT NULL, "reason" TEXT,
  "approvalId" UUID UNIQUE REFERENCES "AmuxV22TaskRecoveryApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "authorizationAuditLogId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22RecoveryPreApprovalResult_audit_key" UNIQUE ("authorizationAuditLogId"),
  CONSTRAINT "AmuxV22RecoveryPreApprovalResult_audit_fkey" FOREIGN KEY ("authorizationAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxV22RecoveryPreApprovalResult_shape_check" CHECK (
    ("outcome" = 'applied' AND "approvalId" IS NOT NULL AND "reason" IS NULL) OR
    ("outcome" = 'refused' AND "approvalId" IS NULL AND "reason" ~ '^[a-z0-9_]{1,128}$'))
);

CREATE TRIGGER amux_v22_recovery_preapproval_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22TaskRecoveryPreApproval" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();
CREATE TRIGGER amux_v22_recovery_preapproval_result_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
 ON "AmuxV22TaskRecoveryPreApprovalResult" FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_recovery_append_only();

-- The consent is created with its own inspection request in one owner
-- transaction, both human audited there.
CREATE FUNCTION amux_v22_recovery_preapproval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE;
BEGIN
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = NEW."inspectionId";
  IF r."id" IS NULL OR r."requestKind" IS DISTINCT FROM 'inspect' OR
     r."riskAcceptanceId" IS NOT NULL OR r."ownerRequestId" IS DISTINCT FROM NEW."ownerRequestId" OR
     r."taskId" IS DISTINCT FROM NEW."taskId" OR r."taskRevision" IS DISTINCT FROM NEW."taskRevision" OR
     r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR
     r."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId" OR
     r."requestedAt" IS DISTINCT FROM NEW."requestedAt" OR
     NOT EXISTS (SELECT 1 FROM "AmuxV22TaskRecoveryInspectionRequest" same
       WHERE same."id" = r."id" AND same.xmin = pg_current_xact_id()::xid) OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND
       a."entryHash" IS NOT NULL AND a."action" = 'amux.v22.recovery.preapproved' AND
       a."targetType" = 'AmuxV22TaskRecoveryPreApproval' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" = NEW."requestedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'inspectionId' = NEW."inspectionId"::text AND
       a."metadata"->>'costDigest' = NEW."costDigest" AND
       a."metadata"->>'additionalCapMicroUsd' = NEW."additionalCapMicroUsd"::text AND
       a."metadata"->>'expiresAt' IS NOT NULL AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery pre-approval is not exact and human audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryPreApproval_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_preapproval_guard_trigger AFTER INSERT
 ON "AmuxV22TaskRecoveryPreApproval" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_preapproval_guard();

CREATE FUNCTION amux_v22_recovery_preapproval_result_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ap "AmuxV22TaskRecoveryApproval"%ROWTYPE;
BEGIN
  SELECT * INTO ap FROM "AmuxV22TaskRecoveryApproval" WHERE "preApprovalId" = NEW."preApprovalId";
  IF (NEW."outcome" = 'applied' AND (ap."id" IS DISTINCT FROM NEW."approvalId" OR
       NOT EXISTS (SELECT 1 FROM "AmuxV22TaskRecoveryApproval" same
         WHERE same."id" = ap."id" AND same.xmin = pg_current_xact_id()::xid))) OR
     (NEW."outcome" = 'refused' AND ap."id" IS NOT NULL) OR
     NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND
       a."entryHash" IS NOT NULL AND a."action" = 'amux.v22.recovery.preapproval_settled' AND
       a."targetType" = 'AmuxV22TaskRecoveryPreApprovalResult' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" IS NULL AND a."metadata"->>'systemActor' = 'amux-v22-recovery-preapproval' AND
       a."metadata"->>'preApprovalId' = NEW."preApprovalId"::text AND
       a."metadata"->>'outcome' = NEW."outcome" AND
       a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'Recovery pre-approval result is not exact and system audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryPreApprovalResult_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_recovery_preapproval_result_guard_trigger AFTER INSERT
 ON "AmuxV22TaskRecoveryPreApprovalResult" DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION amux_v22_recovery_preapproval_result_guard();

CREATE OR REPLACE FUNCTION amux_v22_recovery_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r "AmuxV22TaskRecoveryInspectionRequest"%ROWTYPE; e "AmuxV22TaskRecoveryEvidence"%ROWTYPE;
 w "AmuxWorkItem"%ROWTYPE; pa "AmuxV22TaskRecoveryPreApproval"%ROWTYPE;
 used INTEGER; next_number INTEGER; held BIGINT;
 db_now TIMESTAMP(3) := clock_timestamp() AT TIME ZONE 'UTC';
 consent_ok BOOLEAN;
BEGIN
  SELECT * INTO r FROM "AmuxV22TaskRecoveryInspectionRequest" WHERE "id" = NEW."inspectionId";
  SELECT * INTO e FROM "AmuxV22TaskRecoveryEvidence" WHERE "id" = NEW."evidenceId";
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."taskId";
  SELECT count(*)::integer, greatest(count(*)::integer, coalesce(max("attemptNumber"),0)) + 1,
    coalesce(sum("reservedCostMicrousd"),0) INTO used, next_number, held
    FROM "AmuxExecutionAttempt" WHERE "taskId" = NEW."taskId";
  IF NEW."preApprovalId" IS NULL THEN
    -- The owner approves in this transaction. Inspect evidence stays valid for
    -- the 15 minutes a person needs to read it; safe-stop evidence for 90 s.
    consent_ok := e."recordedAt" <= db_now AND e."recordedAt" >= r."requestedAt" AND
      db_now - e."recordedAt" <= CASE WHEN r."requestKind" = 'inspect' AND
        NEW."riskAcceptanceId" IS NULL THEN INTERVAL '15 minutes' ELSE INTERVAL '90 seconds' END AND
      EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.approved' AND a."targetType" = 'AmuxV22TaskRecoveryApproval' AND a."targetId" = NEW."id"::text AND
       a."actorUserId" = NEW."approvedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND a."metadata"->>'costDigest' = NEW."costDigest" AND
       a."metadata"->>'oldHeldMicroUsd' = NEW."oldHeldMicroUsd"::text AND a."metadata"->>'additionalCapMicroUsd' = NEW."additionalCapMicroUsd"::text AND
       a."metadata"->>'ownerRequestId' = NEW."ownerRequestId"::text AND a.xmin = pg_current_xact_id()::xid);
  ELSE
    -- The owner consented earlier, for this inspection, at this exact cost;
    -- the evidence came after the consent and the consent has not expired.
    SELECT * INTO pa FROM "AmuxV22TaskRecoveryPreApproval" WHERE "id" = NEW."preApprovalId";
    consent_ok := pa."id" IS NOT NULL AND r."requestKind" = 'inspect' AND
      NEW."riskAcceptanceId" IS NULL AND NEW."launchProofId" IS NULL AND
      pa."inspectionId" = NEW."inspectionId" AND pa."taskId" = NEW."taskId" AND
      pa."taskRevision" = NEW."beforeRevision" AND pa."priorAttemptId" = NEW."priorAttemptId" AND
      pa."requestedByUserId" = NEW."approvedByUserId" AND pa."ownerRequestId" = NEW."ownerRequestId" AND
      pa."costDigest" = NEW."costDigest" AND pa."additionalCapMicroUsd" = NEW."additionalCapMicroUsd" AND
      pa."oldHeldMicroUsd" = NEW."oldHeldMicroUsd" AND pa."catalogApprovalId" = NEW."catalogApprovalId" AND
      pa."costReceiptDigest" = NEW."costReceiptDigest" AND
      e."recordedAt" >= pa."requestedAt" AND db_now <= pa."expiresAt" AND
      EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = pa."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.preapproved' AND a."targetType" = 'AmuxV22TaskRecoveryPreApproval' AND
       a."targetId" = pa."id"::text AND a."actorUserId" = pa."requestedByUserId" AND NOT (a."metadata" ? 'systemActor') AND
       a."metadata"->>'costDigest' = pa."costDigest") AND
      EXISTS (SELECT 1 FROM "AdminAuditLog" a WHERE a."id" = NEW."authorizationAuditLogId" AND a."entryHash" IS NOT NULL AND
       a."action" = 'amux.v22.recovery.preapproval_applied' AND a."targetType" = 'AmuxV22TaskRecoveryApproval' AND
       a."targetId" = NEW."id"::text AND a."actorUserId" IS NULL AND
       a."metadata"->>'systemActor' = 'amux-v22-recovery-preapproval' AND
       a."metadata"->>'preApprovalId' = pa."id"::text AND
       a."metadata"->>'evidenceDigest' = NEW."evidenceDigest" AND a."metadata"->>'costDigest' = NEW."costDigest" AND
       a."metadata"->>'oldHeldMicroUsd' = NEW."oldHeldMicroUsd"::text AND a."metadata"->>'additionalCapMicroUsd' = NEW."additionalCapMicroUsd"::text AND
       a."metadata"->>'ownerRequestId' = NEW."ownerRequestId"::text AND a.xmin = pg_current_xact_id()::xid);
  END IF;
  IF r."taskId" IS DISTINCT FROM NEW."taskId" OR r."taskRevision" IS DISTINCT FROM NEW."beforeRevision" OR
     r."priorAttemptId" IS DISTINCT FROM NEW."priorAttemptId" OR r."requestedByUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
     e."inspectionId" IS DISTINCT FROM r."id" OR e."verified" IS DISTINCT FROM true OR
     e."evidenceDigest" IS DISTINCT FROM NEW."evidenceDigest" OR consent_ok IS NOT TRUE OR
     w."status" IS DISTINCT FROM 'todo' OR w."revision" IS DISTINCT FROM NEW."afterRevision" OR
     w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     used IS DISTINCT FROM NEW."historicalAttempts" OR next_number IS DISTINCT FROM NEW."nextAttemptNumber" OR held IS DISTINCT FROM NEW."oldHeldMicroUsd" THEN
    RAISE EXCEPTION 'Recovery approval is not exact and owner authorized'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryApproval_binding_check';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
