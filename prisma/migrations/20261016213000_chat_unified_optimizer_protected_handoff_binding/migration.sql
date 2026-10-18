-- Recheck the exact plan-to-cycle relationship when the one-use handoff
-- commits, including after waiting behind the audit or cost-ledger lock.
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
      OR clock_timestamp() >= q."provenanceExpiresAt"
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
