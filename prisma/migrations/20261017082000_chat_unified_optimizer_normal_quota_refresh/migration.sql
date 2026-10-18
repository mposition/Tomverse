-- Normal-cycle plans may span Brisbane days. The measured quota contract is
-- immutable, but its initial observation is not a substitute for the fresh
-- per-dispatch observation on the hold. Keep S0's one-shot expiry rule.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_dispatch_intent_fresh_at_commit"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary_invalid BOOLEAN;
BEGIN
  SELECT
    p."state" <> 'active'
    OR cr."state" <> 'active'
    OR r."state" <> 'succeeded'
    OR c."state" <> 'succeeded'
    OR j."state" <> 'succeeded'
    OR c."externalDispatchAuthorized" OR c."paidAuthorized"
    OR r."externalDispatchAuthorized" OR r."paidAuthorized"
    OR j."externalDispatchAuthorized" OR j."paidAuthorized"
    OR h."externalDispatchAuthorized"
    OR clock_timestamp() >= r."deadlineAt"
    OR clock_timestamp() >= j."deadlineAt"
    OR clock_timestamp() >= cc."priceExpiresAt"
    OR (p."purpose" = 's0_probe'
      AND clock_timestamp() >= q."provenanceExpiresAt")
    OR clock_timestamp() >= h."preQuotaExpiresAt"
  INTO boundary_invalid
  FROM "ChatUnifiedOptimizerDispatchHold" h
  JOIN "ChatUnifiedOptimizerCostPlan" p ON p."id" = h."planId"
  JOIN "ChatUnifiedOptimizerCostRun" cr ON cr."id" = h."runId"
  JOIN "ChatUnifiedOptimizerCostCall" cc ON cc."id" = h."callBucketId"
  JOIN "ChatUnifiedOptimizerQuotaContract" q
    ON q."id" = cc."quotaContractId"
  JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
  JOIN "ChatUnifiedOptimizerCycle" c ON c."id" = r."cycleId"
  JOIN "ChatUnifiedOptimizerRoleJob" j
    ON j."id" = cc."optimizerRoleJobId" AND j."runId" = r."id"
  WHERE h."id" = NEW."id";

  IF boundary_invalid IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'chat_unified_optimizer_dispatch_intent_stale_at_commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- Handoff uses the same durable fresh hold observation. Retain all other
-- source, stop, cost and deadline checks from the reviewed prior function.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_protected_handoff_fresh_at_commit"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary_invalid BOOLEAN;
BEGIN
  SELECT h."state" <> 'dispatch_intended'
      OR h."externalDispatchAuthorized"
      OR p."state" <> 'active' OR cr."state" <> 'active'
      OR r."state" <> 'succeeded' OR c."state" <> 'succeeded'
      OR j."state" <> 'succeeded'
      OR c."externalDispatchAuthorized" OR c."paidAuthorized"
      OR r."externalDispatchAuthorized" OR r."paidAuthorized"
      OR j."externalDispatchAuthorized" OR j."paidAuthorized"
      OR clock_timestamp() >= NEW."expiresAt"
      OR clock_timestamp() >= r."deadlineAt"
      OR clock_timestamp() >= j."deadlineAt"
      OR clock_timestamp() >= cc."priceExpiresAt"
      OR (p."purpose" = 's0_probe'
        AND clock_timestamp() >= q."provenanceExpiresAt")
      OR clock_timestamp() >= h."preQuotaExpiresAt"
      OR EXISTS (SELECT 1 FROM "AppSetting" s
        WHERE s."key"='chat.unified_optimizer.stop_latch.v1')
    INTO boundary_invalid
    FROM "ChatUnifiedOptimizerDispatchHold" h
    JOIN "ChatUnifiedOptimizerCostPlan" p ON p."id"=h."planId"
    JOIN "ChatUnifiedOptimizerCostRun" cr ON cr."id"=h."runId"
    JOIN "ChatUnifiedOptimizerCostCall" cc ON cc."id"=h."callBucketId"
    JOIN "ChatUnifiedOptimizerQuotaContract" q
      ON q."id"=cc."quotaContractId"
    JOIN "ChatUnifiedOptimizerRoleJob" j
      ON j."id"=cc."optimizerRoleJobId"
    JOIN "ChatUnifiedOptimizerRun" r ON r."id"=j."runId"
      AND r."id"=cr."optimizerRunId"
    JOIN "ChatUnifiedOptimizerCycle" c ON c."id"=r."cycleId"
      AND c."id"=p."cycleId"
    WHERE h."intentId"=NEW."intentId";
  IF boundary_invalid IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'chat_unified_optimizer_protected_handoff_stale_at_commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
