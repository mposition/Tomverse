-- Owner direction 2026-11-15: a card's attempt numbers may run past five
-- (infrastructure failures keep their number but do not count; the app's
-- runaway guard is thirty counted attempts). An owner's recovery retry of
-- such a card named a next attempt above five, which this guard refused. The
-- bound is now 64, as for the v22 attempt guard
-- (20261116011500_amux_v22_attempt_number_bound). The exact one-attempt
-- authority it checks is unchanged.
-- baseline-check: replace-function-if-body-sha256 "amux_v22_recovery_attempt_guard" "49f42cf5e00dbfe9c5740f09c83ff4c52d4e51f95325b64f1f92ccc545638b0b" "c50de03d1fca6243581c0b9e1d2a3ad24a07d7cd4b988201028dabbb095fd02f"
CREATE OR REPLACE FUNCTION amux_v22_recovery_attempt_guard() RETURNS trigger
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
     recovery."nextAttemptNumber" NOT BETWEEN 1 AND 64 OR
     NEW."attemptNumber" IS DISTINCT FROM recovery."nextAttemptNumber" OR
     NEW."reservedCostMicrousd" <= 0 OR NEW."reservedCostMicrousd" > recovery."additionalCapMicroUsd" OR
     attempt_count IS DISTINCT FROM recovery."historicalAttempts" + 1 OR
     held IS DISTINCT FROM recovery."oldHeldMicroUsd" + NEW."reservedCostMicrousd" THEN
    RAISE EXCEPTION 'Recovery attempt does not consume its exact one-attempt authority'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22RecoveryAttempt_binding_check';
  END IF;
  RETURN NEW;
END $$;
