-- baseline-check: replace-function-if-body-sha256 "amux_v22_v39_launch_proof_guard" "42878a7eb9a83b29eaaf2233ed6470ef328ae9bd0d70bf5a4ffa138312caefce"
-- Policy v39 follow-up. PostgreSQL 17 parses the two unparenthesized JSONB
-- operators in the applied function as `unknown - unknown`. Replace only that
-- function body and keep every binding, audit and freshness condition intact.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v22_v39_launch_proof_guard() RETURNS trigger
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
     (NEW."report"->'launchScope') - 'launcherConfigDigest'::text IS DISTINCT FROM
       c."launchScope" - 'launcherConfigDigest'::text OR
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

COMMIT;
