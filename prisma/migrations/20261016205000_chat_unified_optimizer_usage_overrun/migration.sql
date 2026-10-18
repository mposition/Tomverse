-- A verified provider usage fact can exceed its admission ceiling. Keep the
-- immutable measured fact and require the affected plan/run to stop as overrun.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_cost_plan_complete"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_plan UUID;
DECLARE plan_row "ChatUnifiedOptimizerCostPlan"%ROWTYPE;
DECLARE expected_runs INTEGER;
DECLARE run_count INTEGER;
DECLARE quote_total BIGINT;
DECLARE invalid_runs INTEGER;
DECLARE invalid_calls INTEGER;
DECLARE invalid_sequences INTEGER;
DECLARE succeeded_runs INTEGER;
DECLARE stopped_unknown_runs INTEGER;
DECLARE stopped_overrun_runs INTEGER;
DECLARE stopped_late_runs INTEGER;
DECLARE active_or_planned_runs INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCostPlan' THEN
    target_plan := NEW."id";
  ELSIF TG_TABLE_NAME IN ('ChatUnifiedOptimizerCostRun',
      'ChatUnifiedOptimizerQuotaContract', 'ChatUnifiedOptimizerCostCall',
      'ChatUnifiedOptimizerDispatchHold') THEN
    target_plan := NEW."planId";
  ELSE
    RETURN NULL;
  END IF;
  SELECT * INTO plan_row FROM "ChatUnifiedOptimizerCostPlan" WHERE "id" = target_plan;
  IF plan_row."id" IS NULL THEN RETURN NULL; END IF;
  expected_runs := CASE WHEN plan_row."purpose" = 'normal_cycle' THEN 3 ELSE 1 END;
  SELECT COUNT(*), COALESCE(SUM("quotedMicroUsd"), 0),
    COUNT(*) FILTER (WHERE
      (plan_row."purpose" = 'normal_cycle' AND "questionCount" < 80)
      OR (plan_row."purpose" = 's0_probe' AND "ordinal" <> 1)),
    COUNT(*) FILTER (WHERE "state" = 'succeeded'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_unknown'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_overrun'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_late'),
    COUNT(*) FILTER (WHERE "state" IN ('active', 'planned'))
  INTO run_count, quote_total, invalid_runs, succeeded_runs,
    stopped_unknown_runs, stopped_overrun_runs, stopped_late_runs,
    active_or_planned_runs
  FROM "ChatUnifiedOptimizerCostRun" WHERE "planId" = target_plan;
  SELECT COUNT(*) INTO invalid_calls FROM "ChatUnifiedOptimizerCostRun" r
  WHERE r."planId" = target_plan AND (
    r."quotedMicroUsd" <> COALESCE((SELECT SUM(c."calls"::bigint *
      c."worstCaseMicroUsdPerCall") FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."runId" = r."id"), -1)
    OR NOT EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."runId" = r."id"));
  SELECT COUNT(*) INTO invalid_sequences FROM "ChatUnifiedOptimizerCostCall" c
  WHERE c."planId" = target_plan AND EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
    WHERE h."callBucketId" = c."id"
    HAVING COUNT(*) <> MAX(h."invocationOrdinal")
      OR MIN(h."invocationOrdinal") <> 1
      OR MAX(h."invocationOrdinal") > c."calls");
  IF run_count <> expected_runs OR quote_total <> plan_row."wholePlanQuotedMicroUsd"
    OR invalid_runs <> 0 OR invalid_calls <> 0 OR invalid_sequences <> 0
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerQuotaContract" q
      WHERE q."planId" = target_plan AND NOT EXISTS (
        SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
        WHERE c."quotaContractId" = q."id"))
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."planId" = target_plan AND c."priceExpiresAt" <= plan_row."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF plan_row."state" = 'active' THEN
    IF stopped_unknown_runs + stopped_overrun_runs + stopped_late_runs <> 0 THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_state_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'succeeded' THEN
    IF succeeded_runs <> expected_runs OR EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerCostRun" cr
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
      WHERE cr."planId" = target_plan AND clock_timestamp() >= r."deadlineAt") THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_late_success' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_unknown' THEN
    IF stopped_unknown_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold"
      WHERE "planId" = target_plan
        AND "state" IN ('outcome_unknown', 'quota_outcome_unknown')) THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_unknown_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_overrun' THEN
    IF stopped_overrun_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold"
      WHERE "planId" = target_plan AND "state" = 'settled'
        AND ("settledMicroUsd" > "reservedMicroUsd"
          OR "settledInputTokens" > "inputTokensCap"
          OR "settledOutputTokens" > "outputTokensCap")) THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_overrun_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_late' THEN
    IF stopped_late_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerCostRun" cr
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
      WHERE cr."planId" = target_plan AND clock_timestamp() >= r."deadlineAt") THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_late_invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerCostRun" r WHERE r."planId" = target_plan
      AND ((r."state" = 'planned' AND EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h WHERE h."runId" = r."id"))
        OR (r."state" = 'active' AND (
          NOT EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id")
          OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id"
              AND h."state" IN ('outcome_unknown', 'quota_outcome_unknown'))
          OR (SELECT COUNT(*) FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id" AND h."state" = 'settled') =
             (SELECT COALESCE(SUM(c."calls"), 0)
              FROM "ChatUnifiedOptimizerCostCall" c WHERE c."runId" = r."id")))
        OR (r."state" = 'succeeded' AND (
          (SELECT COUNT(*) FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id" AND h."state" = 'settled') <>
          (SELECT COALESCE(SUM(c."calls"), 0) FROM "ChatUnifiedOptimizerCostCall" c
            WHERE c."runId" = r."id")))
        OR (r."state" = 'stopped_unknown' AND NOT EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
          WHERE h."runId" = r."id"
            AND h."state" IN ('outcome_unknown', 'quota_outcome_unknown')))
        OR (r."state" = 'stopped_overrun' AND NOT EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
          WHERE h."runId" = r."id" AND h."state" = 'settled'
            AND (h."settledMicroUsd" > h."reservedMicroUsd"
              OR h."settledInputTokens" > h."inputTokensCap"
              OR h."settledOutputTokens" > h."outputTokensCap"))))) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_run_state_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
