-- baseline-check: replace-function-if-body-sha256 "amux_v21_session_claim_mode_guard" "d0c0caeefa3c4a5f862eb219b010ab0a3a703e82b00e61434ea7a99e7a1a66ce"
-- AMUX intake v21 (owner decision 2026-10-20): a subscription CLI channel
-- spends no money, so when the owner closes an outcome_unknown max_shadow
-- claim without proof that the CLI never started (`not_proven`), the claim
-- closes as owner_consumed at zero. Its occupied headroom is returned to the
-- month instead of being counted as this month's usage; the closure audit
-- records shadowUsage "unknown" and headroomCounted false.
--
-- The claim CHECK keeps every other rule and additionally admits a zero
-- owner_consumed settlement for max_shadow only. A bounded claim still
-- settles owner_consumed at its full reservation. A max_shadow row closed
-- before this migration at its full reservation still satisfies the CHECK:
-- its audited settlement is not rewritten. For every new closure the mode
-- guard below requires the zero settlement and its same-transaction audit.
-- The function body is the 20261020090000 one with only the owner_consumed
-- branch added; its signature and trigger are unchanged.
BEGIN;

ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim"
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check" CHECK (
    "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
    "invocationOrdinal" >= 0 AND
    "inputMicroUsdPerMillion" > 0 AND "outputMicroUsdPerMillion" > 0 AND
    "reservedMicroUsd" > 0 AND
    "budgetMode" IN ('bounded', 'max_shadow') AND
    "provider" IN ('openai', 'anthropic', 'github-copilot', 'cursor') AND
    "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' AND
    (("status" = 'in_flight' AND "closedAt" IS NULL AND
      "settledMicroUsd" IS NULL AND "inputTokens" IS NULL AND
      "outputTokens" IS NULL AND "resolutionAuditLogId" IS NULL) OR
     ("status" = 'outcome_unknown' AND "closedAt" IS NULL AND
      "settledMicroUsd" IS NULL AND "inputTokens" IS NULL AND
      "outputTokens" IS NULL AND "resolutionAuditLogId" IS NOT NULL) OR
     ("status" IN ('succeeded', 'failed', 'owner_consumed', 'released') AND
      "closedAt" IS NOT NULL AND "closedAt" >= "createdAt" AND
      "settledMicroUsd" >= 0 AND
      ("settledMicroUsd" <= "reservedMicroUsd" OR
       ("budgetMode" = 'max_shadow' AND "status" IN ('succeeded', 'failed'))) AND
      "resolutionAuditLogId" IS NOT NULL AND
      (("status" IN ('succeeded', 'failed') AND
        "settledMicroUsd" > 0 AND
        "inputTokens" >= 0 AND "outputTokens" >= 0 AND
        "inputTokens" + "outputTokens" > 0) OR
       ("status" = 'owner_consumed' AND
        ("settledMicroUsd" = "reservedMicroUsd" OR
         ("budgetMode" = 'max_shadow' AND "settledMicroUsd" = 0)) AND
        "inputTokens" IS NULL AND "outputTokens" IS NULL) OR
       ("status" = 'released' AND "settledMicroUsd" = 0 AND
        "inputTokens" IS NULL AND "outputTokens" IS NULL))))
  );

CREATE OR REPLACE FUNCTION "amux_v21_session_claim_mode_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE window_row record; audit_row record; reservation_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session budget claims cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."budgetMode" IS DISTINCT FROM OLD."budgetMode" THEN
    RAISE EXCEPTION 'session claim budget mode is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."budgetMode" <> 'max_shadow' THEN RETURN NEW; END IF;
  SELECT * INTO window_row FROM "AmuxIdeaAnalysisBudgetWindow"
    WHERE "namespace" = NEW."namespace" AND "monthStart" = NEW."monthStart";
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."claimAuditLogId";
    SELECT "ideaId", "reasoningEffort", "modelProvider", "modelId" INTO reservation_row
      FROM "AmuxIdeaSessionAnalysisReservation"
      WHERE "id" = NEW."reservationId";
    IF window_row."limitMicroUsd" IS NULL OR
       window_row."spentMicroUsd"::numeric +
         window_row."reservedMicroUsd"::numeric +
         window_row."shadowOverrunMicroUsd"::numeric <> window_row."limitMicroUsd" OR
       audit_row."id" IS NULL OR
       audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."action" <> 'amux.v19.session_budget.claimed' OR
       audit_row."targetType" <> 'AmuxIdeaSessionAnalysisBudgetClaim' OR
       audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
       audit_row."actorUserId" IS NOT NULL OR
       -- The claim runs the reserved channel and model, not one it names itself.
       NEW."provider" IS DISTINCT FROM reservation_row."modelProvider" OR
       NEW."modelId" IS DISTINCT FROM reservation_row."modelId" OR
       -- One subscription sign-in profile per channel, the same map as
       -- lib/amux/ideaAnalysisChannelCore.ts. No profile or channel refuses.
       NOT COALESCE(audit_row."metadata"->>'maxAuthProfile' =
         CASE NEW."provider"
           WHEN 'openai' THEN 'codex-chatgpt'
           WHEN 'anthropic' THEN 'claude-max-oauth'
           WHEN 'github-copilot' THEN 'copilot-github'
           WHEN 'cursor' THEN 'cursor-login'
         END, false) OR
       NOT COALESCE((audit_row."metadata"->>'maxAuthEvidenceDigest') ~
         '^[a-f0-9]{64}$', false) OR
       audit_row."metadata"->>'ideaId' IS DISTINCT FROM reservation_row."ideaId" OR
       audit_row."metadata"->>'modelId' IS DISTINCT FROM NEW."modelId" OR
       audit_row."metadata"->>'reasoningEffort' IS DISTINCT FROM
         reservation_row."reasoningEffort" OR
       audit_row."metadata"->>'budgetMode' IS DISTINCT FROM 'max_shadow' OR
       audit_row."metadata"->>'amountMeaning' IS DISTINCT FROM
         'cli_shadow_headroom_not_ceiling' THEN
      RAISE EXCEPTION 'Max shadow claim must occupy remaining headroom'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" IN ('succeeded', 'failed') THEN
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."resolutionAuditLogId";
    IF audit_row."id" IS NULL OR audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."metadata"->>'budgetMode' <> 'max_shadow' OR
       audit_row."metadata"->>'settledMicroUsd' IS DISTINCT FROM
         NEW."settledMicroUsd"::text OR
       audit_row."metadata"->>'shadowOverrunMicroUsd' IS DISTINCT FROM
         GREATEST(NEW."settledMicroUsd" - NEW."reservedMicroUsd", 0)::text THEN
      RAISE EXCEPTION 'Max shadow settlement audit mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" = 'owner_consumed' THEN
    -- An unproven subscription run spent no money: it closes at zero and the
    -- same-transaction owner audit says its usage is unknown and uncounted.
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."resolutionAuditLogId";
    IF NEW."settledMicroUsd" IS DISTINCT FROM 0 OR
       audit_row."id" IS NULL OR audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."metadata"->>'budgetMode' IS DISTINCT FROM 'max_shadow' OR
       audit_row."metadata"->>'shadowUsage' IS DISTINCT FROM 'unknown' OR
       audit_row."metadata"->'headroomCounted' IS DISTINCT FROM 'false'::jsonb OR
       audit_row."metadata"->>'settledMicroUsd' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'Max shadow unknown closure must return its headroom'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
