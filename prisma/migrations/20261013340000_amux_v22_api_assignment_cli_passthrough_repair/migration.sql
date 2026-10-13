-- baseline-check: replace-function-if-body-sha256 "amux_v22_v42_assignment_model_access_guard" "96381e41cb5ba9e91338aa3023ecf31f4ccfa8f7ccad6ea0f91a11105b4ef667"
-- Policy v42 repair: the 300 assignment guard returned early with
-- `executorKind <> 'read_only_api_retry_v1'`. A CLI read-only proof, and a
-- recovery approval with no launch proof, has no executorKind, so the test was
-- NULL, the guard fell through and demanded API model-access evidence, and
-- every CLI or ordinary recovery claim was refused. Use IS DISTINCT FROM, as
-- the 300 approval guard and 330 already do; the API branch is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v22_v42_assignment_model_access_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  approval "AmuxV22TaskRecoveryApproval"%ROWTYPE;
  evidence "AmuxV22ApiModelAccessEvidence"%ROWTYPE;
  proof "AmuxV22ReadOnlyLaunchProof"%ROWTYPE;
BEGIN
  IF NEW."recoveryApprovalId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO approval FROM "AmuxV22TaskRecoveryApproval"
    WHERE "id" = NEW."recoveryApprovalId" FOR KEY SHARE;
  SELECT * INTO proof FROM "AmuxV22ReadOnlyLaunchProof"
    WHERE "id" = approval."launchProofId" FOR KEY SHARE;
  IF proof."report" #>> '{launchScope,executorKind}' IS DISTINCT FROM
       'read_only_api_retry_v1' THEN RETURN NEW; END IF;
  SELECT * INTO evidence FROM "AmuxV22ApiModelAccessEvidence"
    WHERE "id" = approval."apiModelAccessEvidenceId" FOR KEY SHARE;
  IF evidence."accessState" IS DISTINCT FROM 'verified' OR
     evidence."recordedAt" + INTERVAL '90 seconds' < CURRENT_TIMESTAMP OR
     evidence."workerName" IS DISTINCT FROM NEW."workerName" OR
     evidence."workerInstanceId" IS DISTINCT FROM NEW."workerInstanceId" OR
     evidence."workerGeneration" IS DISTINCT FROM NEW."workerGeneration" OR
     evidence."provider" IS DISTINCT FROM NEW."provider" OR
     evidence."selectedModelId" IS DISTINCT FROM NEW."modelId" OR
     evidence."canonicalModelId" IS DISTINCT FROM NEW."modelId" OR
     evidence."apiExecutionFrameDigest" IS DISTINCT FROM
       proof."report" #>> '{launchScope,apiExecutionFrameDigest}' OR
     evidence."launcherConfigDigest" IS DISTINCT FROM
       proof."report" #>> '{launchScope,launcherConfigDigest}' THEN
    RAISE EXCEPTION 'API assignment requires fresh exact model access evidence'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV22Assignment_api_access_binding_check';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
