-- baseline-check: replace-function-if-body-sha256 "amux_v22_v39_launch_capability_guard" "3042b6f3159a6933cb62034b63e8449c69a1a97bf6f84b00a7bff11e97a0acdb"
-- Policy v40 extends the existing read-only retry rows to the native API
-- executor without changing their identity, cost, once-only or fence rules.
-- Each database boundary requires the one exact capability selected by the
-- immutable launch scope: an absent executorKind is the v39 CLI profile; the
-- sole accepted executorKind is the v40 API profile. Unknown values fail.
BEGIN;

-- The baseline header can pin one replacement. Pin all four old bodies again
-- inside the transaction before replacing any of them.
DO $pin$
DECLARE
    pinned RECORD;
    actual TEXT;
BEGIN
    FOR pinned IN
        SELECT * FROM (VALUES
            ('3042b6f3159a6933cb62034b63e8449c69a1a97bf6f84b00a7bff11e97a0acdb', 'amux_v22_v39_launch_capability_guard'),
            ('c207f179c567273daaef25d8481fa9345b7ed5aa4a2afc1ada8a1d17f6dc8ffd', 'amux_v22_v39_approval_capability_guard'),
            ('0e97a7ab2f68b01b624d5e0a52ad5bddaed19d53a5e1439ace9686656c3aed1f', 'amux_v22_v39_assignment_capability_guard'),
            ('11ee70d829ee29879425917ca6b679a765fbcd3f4e88104d80cdc848d0f5ee6a', 'amux_v22_v39_attempt_capability_guard')
        ) AS pins("sha256", "name")
    LOOP
        SELECT pg_catalog.encode(pg_catalog.sha256(
                 pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
          INTO actual
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = pg_catalog.current_schema()
           AND p.proname = pinned."name"
           AND p.pronargs = 0
           AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;
        IF actual IS DISTINCT FROM pinned."sha256" THEN
            RAISE EXCEPTION 'AMUX_V22_UNEXPECTED_CAPABILITY_GUARD_BODY %',
              pinned."name";
        END IF;
    END LOOP;
END
$pin$;

CREATE OR REPLACE FUNCTION amux_v22_v39_launch_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AmuxWorkerRuntime" runtime
    WHERE runtime."workerName" = NEW."workerName"
      AND runtime."instanceId" = NEW."workerInstanceId"
      AND runtime."generation" = NEW."workerGeneration"
      AND (
        (NOT (NEW."launchScope" ? 'executorKind') AND
          runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[])
        OR
        (NEW."launchScope"->>'executorKind' = 'read_only_api_retry_v1' AND
          runtime."protocolCapabilities" = ARRAY['read_only_api_retry_v1']::TEXT[])
      )
  ) THEN
    RAISE EXCEPTION 'Read-only launch worker capability is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22ReadOnlyLaunchCheck_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION amux_v22_v39_approval_capability_guard() RETURNS trigger
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
         AND (
           (NOT (launch_check."launchScope" ? 'executorKind') AND
             runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[])
           OR
           (launch_check."launchScope"->>'executorKind' = 'read_only_api_retry_v1' AND
             runtime."protocolCapabilities" = ARRAY['read_only_api_retry_v1']::TEXT[])
         )
     ) THEN
    RAISE EXCEPTION 'Final consent worker capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryApproval_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION amux_v22_v39_assignment_capability_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = NEW."recoveryApprovalId";
  IF approval."riskAcceptanceId" IS NOT NULL AND (
       NEW."perAttemptMicroUsd" IS DISTINCT FROM approval."additionalCapMicroUsd" OR
       NOT EXISTS (
         SELECT 1
         FROM "AmuxWorkerRuntime" runtime
         JOIN "AmuxV22ReadOnlyLaunchProof" proof
           ON proof."id" = approval."launchProofId"
         JOIN "AmuxV22ReadOnlyLaunchCheck" launch_check
           ON launch_check."id" = proof."launchCheckId"
         WHERE runtime."workerName" = NEW."workerName"
           AND runtime."instanceId" = NEW."workerInstanceId"
           AND runtime."generation" = NEW."workerGeneration"
           AND (
             (NOT (launch_check."launchScope" ? 'executorKind') AND
               runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[])
             OR
             (launch_check."launchScope"->>'executorKind' = 'read_only_api_retry_v1' AND
               runtime."protocolCapabilities" = ARRAY['read_only_api_retry_v1']::TEXT[])
           )
       )
     ) THEN
    RAISE EXCEPTION 'Read-only assignment capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAssignment_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION amux_v22_v39_attempt_capability_guard() RETURNS trigger
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
         SELECT 1
         FROM "AmuxWorkerRuntime" runtime
         JOIN "AmuxV22ReadOnlyLaunchProof" proof
           ON proof."id" = approval."launchProofId"
         JOIN "AmuxV22ReadOnlyLaunchCheck" launch_check
           ON launch_check."id" = proof."launchCheckId"
         WHERE runtime."workerName" = NEW."worker"
           AND runtime."instanceId" = NEW."workerInstanceId"
           AND runtime."generation" = NEW."workerGeneration"
           AND (
             (NOT (launch_check."launchScope" ? 'executorKind') AND
               runtime."protocolCapabilities" = ARRAY['read_only_retry_v1']::TEXT[])
             OR
             (launch_check."launchScope"->>'executorKind' = 'read_only_api_retry_v1' AND
               runtime."protocolCapabilities" = ARRAY['read_only_api_retry_v1']::TEXT[])
           )
       )
     ) THEN
    RAISE EXCEPTION 'Read-only attempt capability or cost is not current'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22RecoveryAttempt_current_capability_check';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
