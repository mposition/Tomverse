-- baseline-check: replace-function-if-body-sha256 "amux_v21_session_claim_mode_guard" "9c1d0800fa4d9839951ddecff75496d0cdf04cec4de4e147908c8f5adb4117a1" "ede6c819f1223a552444dafa076279e5aaa2cd2692323a38076dd01a5044ba0f"
-- Operator, 2026-11-16: a subscription (max_shadow) claim spends no money, so
-- it no longer occupies the month's remaining shadow headroom (which let only
-- one analysis run at a time and stopped all of them once the month's shadow
-- estimate reached the ceiling). A new subscription claim reserves exactly
-- nothing and its claim audit says so (`cli_shadow_record_only`); its measured
-- usage is still recorded against the window as shadow usage. Every other
-- check of the guard is unchanged: the reserved channel and model, the
-- channel's sign-in profile and evidence digest, the idea and reasoning
-- effort, the settlement audit and the zero closure of an unknown claim.
-- The function body is the 20261020120000 one with only the INSERT branch's
-- headroom rule replaced; its signature and trigger are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION "amux_v21_session_claim_mode_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE audit_row record; reservation_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session budget claims cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."budgetMode" IS DISTINCT FROM OLD."budgetMode" THEN
    RAISE EXCEPTION 'session claim budget mode is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."budgetMode" <> 'max_shadow' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."claimAuditLogId";
    SELECT "ideaId", "reasoningEffort", "modelProvider", "modelId" INTO reservation_row
      FROM "AmuxIdeaSessionAnalysisReservation"
      WHERE "id" = NEW."reservationId";
    IF NEW."reservedMicroUsd" IS DISTINCT FROM 0 OR
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
       audit_row."metadata"->>'reservedMicroUsd' IS DISTINCT FROM '0' OR
       audit_row."metadata"->>'amountMeaning' IS DISTINCT FROM
         'cli_shadow_record_only' THEN
      RAISE EXCEPTION 'subscription claim must reserve nothing and record its shadow usage'
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
  ELSIF NEW."status" = 'owner_consumed' AND
        OLD."status" IS DISTINCT FROM 'owner_consumed' THEN
    -- An unproven subscription run spent no money: it closes at zero and the
    -- same-transaction audit (the owner's, or the system's since 2026-11-16)
    -- says its usage is unknown and uncounted. Only the closing transition is
    -- checked; an already closed row (settled at full headroom before this
    -- rule) is not re-judged.
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."resolutionAuditLogId";
    IF NEW."settledMicroUsd" IS DISTINCT FROM 0 OR
       audit_row."id" IS NULL OR audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."action" IS DISTINCT FROM 'amux.v19.session_budget.resolved' OR
       audit_row."targetType" IS DISTINCT FROM 'AmuxIdeaSessionAnalysisBudgetClaim' OR
       audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
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
