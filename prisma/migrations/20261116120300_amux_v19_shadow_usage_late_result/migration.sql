-- baseline-check: replace-function-if-body-sha256 "amux_v21_shadow_window_overrun_guard" "a686fd8707a004c763dc41e78b94bc285e6c474957de5bb11adfec8f6cd1ee6b" "57b83eccc4dd555813d96be9fcded261554d51653d44b862589d9ac15391c3bd"
-- Operator, 2026-11-16: a late subscription result settles a claim the system
-- closed unknown at zero (amux_v19_session_budget_claim_guard). The window's
-- shadow total grows before that claim row moves, so the measured audit may
-- now name a claim that is in flight or one that is owner_consumed with
-- nothing reserved. Every other check is unchanged: the same-transaction
-- system settlement audit, its delta, reservation, reservation amount,
-- status, namespace and month. The function body is the 20261018080000 one
-- with only the claim status condition widened; its trigger is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION "amux_v21_shadow_window_overrun_guard"() RETURNS trigger
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
         c."budgetMode" = 'max_shadow' AND
         (c."status" = 'in_flight' OR
          (c."status" = 'owner_consumed' AND c."reservedMicroUsd" = 0))
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

COMMIT;
