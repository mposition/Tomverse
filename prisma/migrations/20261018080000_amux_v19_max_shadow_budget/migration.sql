-- v19 Max subscription shadow usage can exceed the monthly admission threshold.
-- The original bounded spent/reserved ledger and its v4 total check remain.
BEGIN;

ALTER TABLE "AmuxIdeaAnalysisBudgetWindow"
  ADD COLUMN "shadowOverrunMicroUsd" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_shadow_overrun_check"
    CHECK ("shadowOverrunMicroUsd" >= 0 AND
      "spentMicroUsd"::numeric + "shadowOverrunMicroUsd"::numeric <= 9223372036854775807);

ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim"
  ADD COLUMN "budgetMode" TEXT NOT NULL DEFAULT 'bounded',
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check" CHECK (
    "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
    "invocationOrdinal" >= 0 AND
    "inputMicroUsdPerMillion" > 0 AND "outputMicroUsdPerMillion" > 0 AND
    "reservedMicroUsd" > 0 AND
    "budgetMode" IN ('bounded', 'max_shadow') AND
    ("budgetMode" <> 'max_shadow' OR "provider" = 'anthropic') AND
    "provider" IN ('openai', 'anthropic') AND
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

CREATE FUNCTION "amux_v21_shadow_window_overrun_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE delta bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."shadowOverrunMicroUsd" <> 0 THEN
      RAISE EXCEPTION 'shadow overrun cannot be seeded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."shadowOverrunMicroUsd" = OLD."shadowOverrunMicroUsd" THEN RETURN NEW; END IF;
  delta := NEW."shadowOverrunMicroUsd" - OLD."shadowOverrunMicroUsd";
  IF delta <= 0 OR NOT EXISTS (
    SELECT 1 FROM "AdminAuditLog" a
    JOIN "AmuxIdeaSessionAnalysisBudgetClaim" c
      ON c."id"::text = a."targetId" AND
         c."namespace" = NEW."namespace" AND
         c."monthStart" = NEW."monthStart" AND
         c."budgetMode" = 'max_shadow' AND c."status" = 'in_flight'
    WHERE a.xmin = pg_current_xact_id()::xid AND
      a."action" = 'amux.v19.session_budget.resolved' AND
      a."targetType" = 'AmuxIdeaSessionAnalysisBudgetClaim' AND
      a."actorUserId" IS NULL AND a."entryHash" IS NOT NULL AND
      a."metadata"->>'budgetMode' = 'max_shadow' AND
      a."metadata"->>'shadowOverrunMicroUsd' = delta::text AND
      a."metadata"->>'reservationId' = c."reservationId"::text AND
      a."metadata"->>'reservedMicroUsd' = c."reservedMicroUsd"::text AND
      a."metadata"->>'status' IN ('succeeded', 'failed') AND
      GREATEST((a."metadata"->>'settledMicroUsd')::numeric -
        c."reservedMicroUsd"::numeric, 0)::text = delta::text AND
      a."metadata"->>'namespace' = NEW."namespace" AND
      ((a."metadata"->>'monthStart')::timestamptz AT TIME ZONE 'UTC') = NEW."monthStart"
  ) THEN
    RAISE EXCEPTION 'shadow overrun requires same-transaction measured audit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaAnalysisBudgetWindow_shadow_overrun_guard"
  BEFORE INSERT OR UPDATE ON "AmuxIdeaAnalysisBudgetWindow"
  FOR EACH ROW EXECUTE FUNCTION "amux_v21_shadow_window_overrun_guard"();

CREATE FUNCTION "amux_v21_session_claim_mode_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE window_row record; audit_row record;
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
    IF window_row."limitMicroUsd" IS NULL OR
       window_row."spentMicroUsd"::numeric +
         window_row."reservedMicroUsd"::numeric +
         window_row."shadowOverrunMicroUsd"::numeric <> window_row."limitMicroUsd" OR
       NEW."provider" <> 'anthropic' OR
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
CREATE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_mode_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaSessionAnalysisBudgetClaim"
  FOR EACH ROW EXECUTE FUNCTION "amux_v21_session_claim_mode_guard"();

COMMIT;
