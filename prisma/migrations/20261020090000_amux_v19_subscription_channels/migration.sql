-- baseline-check: replace-function-if-body-sha256 "amux_v21_session_claim_mode_guard" "76e800e64384c7bc3dd3a9f0c3a79cec127bb3a3beb393ac8d02bf1daf5985b9"
-- AMUX intake v19 subscription channels (owner decision 2026-10-20). A
-- provider value names the CLI execution channel: openai (Codex CLI),
-- anthropic (Claude CLI), github-copilot (Copilot CLI) and cursor (Cursor
-- CLI), each signed in with a subscription account. Every provider CHECK on
-- the v19 path widens from two values to these four, so no existing row can
-- fail re-validation. The v21 shadow claim no longer requires anthropic: the
-- mode guard instead binds the claim audit's maxAuthProfile to the claim's own
-- channel. The v4 hold ledger and the CLI usage tables keep two providers.
-- The function body is the 20261018080000 one with only those two lines
-- changed; its signature and trigger are unchanged.
BEGIN;

ALTER TABLE "AmuxIdeaFrontierModelApproval"
  DROP CONSTRAINT "AmuxIdeaFrontierModelApproval_provider_check",
  ADD CONSTRAINT "AmuxIdeaFrontierModelApproval_provider_check" CHECK (
    "provider" IN ('openai', 'anthropic', 'github-copilot', 'cursor')
  );

ALTER TABLE "AmuxIdeaAnalysisPriceVersion"
  DROP CONSTRAINT "AmuxIdeaAnalysisPriceVersion_provider_check",
  ADD CONSTRAINT "AmuxIdeaAnalysisPriceVersion_provider_check" CHECK (
    "provider" IN ('openai', 'anthropic', 'github-copilot', 'cursor')
  );

ALTER TABLE "AmuxIdeaOperatingScopeSetting"
  DROP CONSTRAINT "AmuxIdeaOperatingScopeSetting_value_check",
  ADD CONSTRAINT "AmuxIdeaOperatingScopeSetting_value_check" CHECK (
    "version" > 0 AND
    jsonb_typeof("repositories") = 'array' AND
    jsonb_array_length("repositories") BETWEEN 1 AND 64 AND
    "modelProvider" IN ('openai', 'anthropic', 'github-copilot', 'cursor') AND
    "reasoningEffort" IN ('low', 'medium', 'high', 'xhigh', 'max', 'ultra') AND
    "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  );

ALTER TABLE "AmuxIdeaSessionAnalysisReservation"
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisReservation_provider_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisReservation_provider_check"
    CHECK ("modelProvider" IN ('openai', 'anthropic', 'github-copilot', 'cursor'));

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
        "settledMicroUsd" = "reservedMicroUsd" AND
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
    SELECT "ideaId", "reasoningEffort" INTO reservation_row
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
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
