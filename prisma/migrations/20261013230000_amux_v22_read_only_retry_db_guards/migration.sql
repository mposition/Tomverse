-- baseline-check: present-if-function "amux_v22_v39_launch_capability_guard"
-- Policy v39 follow-up. Keep the approved scope bound to a worker that still
-- advertises the fixed read-only retry protocol at each database boundary.
-- This migration changes no row and does not activate, reserve or execute work.
BEGIN;

CREATE FUNCTION amux_v22_v39_launch_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AmuxWorkerRuntime" runtime
    WHERE runtime."workerName" = NEW."workerName"
      AND runtime."instanceId" = NEW."workerInstanceId"
      AND runtime."generation" = NEW."workerGeneration"
      AND runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'Read-only launch worker capability is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22ReadOnlyLaunchCheck_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER amux_v22_v39_launch_capability_guard_trigger
  AFTER INSERT ON "AmuxV22ReadOnlyLaunchCheck"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_launch_capability_guard();

CREATE FUNCTION amux_v22_v39_approval_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
  launch_check "AmuxV22ReadOnlyLaunchCheck"%ROWTYPE;
BEGIN
  IF NEW."riskAcceptanceId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = NEW."launchProofId";
  SELECT * INTO launch_check FROM "AmuxV22ReadOnlyLaunchCheck"
    WHERE "id" = proof."launchCheckId";
  IF launch_check."id" IS NULL OR
     launch_check."additionalCapMicroUsd" IS DISTINCT FROM NEW."additionalCapMicroUsd" OR
     launch_check."worstExposureMicroUsd" IS DISTINCT FROM NEW."worstExposureMicroUsd" OR
     NOT EXISTS (
       SELECT 1 FROM "AmuxWorkerRuntime" runtime
       WHERE runtime."workerName" = launch_check."workerName"
         AND runtime."instanceId" = launch_check."workerInstanceId"
         AND runtime."generation" = launch_check."workerGeneration"
         AND runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[]
     ) THEN
    RAISE EXCEPTION 'Final consent worker capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryApproval_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER amux_v22_v39_approval_capability_guard_trigger
  AFTER INSERT ON "AmuxV22TaskRecoveryApproval"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_approval_capability_guard();

CREATE FUNCTION amux_v22_v39_assignment_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = NEW."recoveryApprovalId";
  IF approval."riskAcceptanceId" IS NOT NULL AND (
       NEW."perAttemptMicroUsd" IS DISTINCT FROM approval."additionalCapMicroUsd" OR
       NOT EXISTS (
         SELECT 1 FROM "AmuxWorkerRuntime" runtime
         WHERE runtime."workerName" = NEW."workerName"
           AND runtime."instanceId" = NEW."workerInstanceId"
           AND runtime."generation" = NEW."workerGeneration"
           AND runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[]
       )
     ) THEN
    RAISE EXCEPTION 'Read-only assignment capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAssignment_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER amux_v22_v39_assignment_capability_guard_trigger
  AFTER INSERT ON "AmuxV22WorkerAssignment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_assignment_capability_guard();

CREATE FUNCTION amux_v22_v39_attempt_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  assignment "AmuxV22WorkerAssignment"%ROWTYPE;
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
BEGIN
  IF NEW."v22AssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO assignment FROM "AmuxV22WorkerAssignment"
    WHERE "id" = NEW."v22AssignmentId";
  IF assignment."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = assignment."recoveryApprovalId";
  IF approval."riskAcceptanceId" IS NOT NULL AND (
       NEW."reservedCostMicrousd" IS DISTINCT FROM approval."additionalCapMicroUsd" OR
       NOT EXISTS (
         SELECT 1 FROM "AmuxWorkerRuntime" runtime
         WHERE runtime."workerName" = NEW."worker"
           AND runtime."instanceId" = NEW."workerInstanceId"
           AND runtime."generation" = NEW."workerGeneration"
           AND runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[]
       )
     ) THEN
    RAISE EXCEPTION 'Read-only attempt capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAttempt_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER amux_v22_v39_attempt_capability_guard_trigger
  AFTER INSERT ON "AmuxExecutionAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_v22_v39_attempt_capability_guard();

COMMIT;
