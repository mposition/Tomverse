-- baseline-check: replace-function-if-body-sha256 "amux_v19_session_budget_claim_guard" "c576f8330cbd721c199372c2ac376eba815d95db1644b55ee8afb7ceda212bb5" "4bb4879d5aacf7fb310ba1bdacc86b4e5d5d67c3a306a629f80612ce0ed94713"
-- Operator, 2026-11-16 (AMUX idea analysis has no artificial stops). Three
-- rules of the session claim guard change; every other check is unchanged.
--
-- 1. The system closes an unknown subscription outcome. An outcome_unknown
--    max_shadow claim may become owner_consumed at zero through a system
--    audit (systemActor amux-v4-intake, the resolve scope, verification
--    not_proven, closedBy system): the same result as the owner's "not
--    proven" in Admin, with the system as the actor. A bounded (paid API)
--    claim's unknown outcome is still closed only by the owner.
-- 2. A late subscription result is taken. A claim the system closed that way
--    (max_shadow, nothing reserved, settled at zero) may still become
--    succeeded or failed through a system settlement audit that names the
--    closure it follows and says lateAfterUnknown, while it is its idea's
--    newest claim and the owner did not stop it.
-- 3. A failed subscription analysis is claimed again. The next invocation
--    may follow a max_shadow claim that ended failed, owner_consumed or
--    released (not stopped by the owner) as well as a succeeded one; the
--    app paces it (lib/amux/ideaSessionAnalysisRetryCore.ts). The idea stays
--    `submitted` until its first succeeded claim, whatever the ordinal.
-- The function body is the 20261104150000 one with only those branches
-- changed; its signature and trigger are unchanged. No row is changed.
BEGIN;

CREATE OR REPLACE FUNCTION "amux_v19_session_budget_claim_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE audit_row record; reservation_row record; price_row record;
  window_row record; prior_claim_row record; closure_row record;
  outstanding_v4 numeric; outstanding_session numeric; has_result boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session budget claims cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."claimAuditLogId";
    SELECT r."status", r."modelProvider", r."modelId",
           i."state" AS idea_state, i."cancelledAt",
           i."analysisCompletedAt", i."analysisDeadlineAt",
           i."rawCiphertext" IS NOT NULL AS has_raw,
           i."rawPurgedAt",
           i."sourceProvenanceCiphertext" IS NOT NULL AS has_provenance
      INTO reservation_row FROM "AmuxIdeaSessionAnalysisReservation" r
      JOIN "AmuxIdeaSubmission" i ON i."id" = r."ideaId"
      WHERE r."id" = NEW."reservationId" FOR KEY SHARE OF r;
    SELECT "id", "invocationOrdinal", "status", "budgetMode" INTO prior_claim_row
      FROM "AmuxIdeaSessionAnalysisBudgetClaim"
      WHERE "reservationId" = NEW."reservationId"
      ORDER BY "invocationOrdinal" DESC LIMIT 1;
    has_result := EXISTS (SELECT 1 FROM "AmuxIdeaSessionAnalysisBudgetClaim"
      WHERE "reservationId" = NEW."reservationId" AND "status" = 'succeeded');
    SELECT "status", "mode", "provider", "modelId", "inputTokensCap",
           "outputTokensCap", "inputMicroUsdPerMillion",
           "outputMicroUsdPerMillion", "revokedAt", "verifiedAt",
           "approvedAt", "expiresAt"
      INTO price_row FROM "AmuxIdeaAnalysisPriceVersion"
      WHERE "id" = NEW."priceVersionId" FOR KEY SHARE;
    SELECT "reservedMicroUsd" INTO window_row
      FROM "AmuxIdeaAnalysisBudgetWindow"
      WHERE "namespace" = NEW."namespace" AND "monthStart" = NEW."monthStart"
      FOR SHARE;
    SELECT COALESCE(SUM("reservedMicroUsd"), 0) INTO outstanding_v4
      FROM "AmuxIdeaAnalysisBudgetHold"
      WHERE "namespace" = NEW."namespace" AND "monthStart" = NEW."monthStart"
        AND "status" IN ('reserved', 'in_flight', 'outcome_unknown');
    SELECT COALESCE(SUM("reservedMicroUsd"), 0) INTO outstanding_session
      FROM "AmuxIdeaSessionAnalysisBudgetClaim"
      WHERE "namespace" = NEW."namespace" AND "monthStart" = NEW."monthStart"
        AND "status" IN ('in_flight', 'outcome_unknown');
    IF NEW."status" <> 'in_flight' OR
       reservation_row."status" IS DISTINCT FROM 'queued' OR
       reservation_row."cancelledAt" IS NOT NULL OR
       reservation_row."analysisCompletedAt" IS NOT NULL OR
       reservation_row.has_raw IS DISTINCT FROM true OR
       reservation_row."rawPurgedAt" IS NOT NULL OR
       reservation_row.has_provenance IS DISTINCT FROM true OR
       reservation_row."analysisDeadlineAt" IS NULL OR
       reservation_row."analysisDeadlineAt" <=
         (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) OR
       reservation_row.idea_state IS DISTINCT FROM
         (CASE WHEN has_result THEN 'analyzing' ELSE 'submitted' END) OR
       (prior_claim_row."id" IS NULL AND NEW."invocationOrdinal" <> 0) OR
       (prior_claim_row."id" IS NOT NULL AND
         (prior_claim_row."invocationOrdinal" IS DISTINCT FROM
            NEW."invocationOrdinal" - 1 OR
          NOT (prior_claim_row."status" IS NOT DISTINCT FROM 'succeeded' OR
            (prior_claim_row."status" IN ('failed', 'owner_consumed', 'released') AND
             prior_claim_row."budgetMode" IS NOT DISTINCT FROM 'max_shadow' AND
             NEW."budgetMode" IS NOT DISTINCT FROM 'max_shadow' AND
             NOT EXISTS (SELECT 1 FROM "AdminAuditLog" s
               WHERE s."action" = 'amux.v19.session_analysis.stopped' AND
                 s."targetType" = 'AmuxIdeaSessionAnalysisBudgetClaim' AND
                 s."targetId" = prior_claim_row."id"::text))))) OR
       reservation_row."modelProvider" IS DISTINCT FROM NEW."provider" OR
       reservation_row."modelId" IS DISTINCT FROM NEW."modelId" OR
       -- A subscription claim has no price row (owner decision 2026-11-04).
       -- Its fixed rates are lib/amux/ideaAnalysisApprovedCostProfile.ts.
       (NEW."priceVersionId" IS NULL AND
         (NEW."budgetMode" IS DISTINCT FROM 'max_shadow' OR
          ROW(NEW."inputTokensCap", NEW."outputTokensCap",
              NEW."inputMicroUsdPerMillion", NEW."outputMicroUsdPerMillion") IS DISTINCT FROM
          ROW(1000000, 128000, 8000000, 20000000))) OR
       (NEW."priceVersionId" IS NOT NULL AND (
         price_row."status" IS DISTINCT FROM 'approved' OR
         price_row."mode" IS DISTINCT FROM 'subscription_cli' OR
         price_row."revokedAt" IS NOT NULL OR
         -- Price instants are timestamptz; the idea deadline is a UTC-naive
         -- timestamp and is compared with an explicit UTC-naive DB clock above.
         price_row."verifiedAt" IS NULL OR
         price_row."verifiedAt" > clock_timestamp() OR
         price_row."approvedAt" IS NULL OR
         price_row."approvedAt" > clock_timestamp() OR
         price_row."expiresAt" IS NULL OR
         price_row."expiresAt" <= clock_timestamp() OR
         price_row."provider" IS DISTINCT FROM NEW."provider" OR
         price_row."modelId" IS DISTINCT FROM NEW."modelId" OR
         ROW(price_row."inputTokensCap", price_row."outputTokensCap",
             price_row."inputMicroUsdPerMillion",
             price_row."outputMicroUsdPerMillion") IS DISTINCT FROM
         ROW(NEW."inputTokensCap", NEW."outputTokensCap",
             NEW."inputMicroUsdPerMillion", NEW."outputMicroUsdPerMillion"))) OR
       window_row."reservedMicroUsd" IS NULL OR
       window_row."reservedMicroUsd" IS DISTINCT FROM
         outstanding_v4 + outstanding_session + NEW."reservedMicroUsd" OR
       audit_row.xmin <> pg_current_xact_id()::xid OR
       audit_row."entryHash" IS NULL OR
       audit_row."action" <> 'amux.v19.session_budget.claimed' OR
       audit_row."targetType" <> 'AmuxIdeaSessionAnalysisBudgetClaim' OR
       audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
       audit_row."actorUserId" IS NOT NULL OR
       audit_row."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v4-intake' OR
       audit_row."metadata"->>'actorScope' IS DISTINCT FROM 'session-budget-claim-v1' OR
       audit_row."metadata"->>'reservationId' IS DISTINCT FROM NEW."reservationId"::text OR
       audit_row."metadata"->>'invocationOrdinal' IS DISTINCT FROM
         NEW."invocationOrdinal"::text OR
       audit_row."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"::text OR
       audit_row."metadata"->>'priceVersionId' IS DISTINCT FROM NEW."priceVersionId" OR
       ((audit_row."metadata"->>'monthStart')::timestamptz AT TIME ZONE 'UTC')
         IS DISTINCT FROM NEW."monthStart" OR
       audit_row."metadata"->>'reservedMicroUsd' IS DISTINCT FROM NEW."reservedMicroUsd"::text THEN
      RAISE EXCEPTION 'session budget claim audit mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."reservationId", NEW."invocationOrdinal",
         NEW."requestId", NEW."namespace",
         NEW."monthStart", NEW."priceVersionId", NEW."provider", NEW."modelId",
         NEW."inputTokensCap", NEW."outputTokensCap",
         NEW."inputMicroUsdPerMillion", NEW."outputMicroUsdPerMillion",
         NEW."reservedMicroUsd", NEW."claimAuditLogId", NEW."createdAt")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."reservationId", OLD."invocationOrdinal",
         OLD."requestId", OLD."namespace",
         OLD."monthStart", OLD."priceVersionId", OLD."provider", OLD."modelId",
         OLD."inputTokensCap", OLD."outputTokensCap",
         OLD."inputMicroUsdPerMillion", OLD."outputMicroUsdPerMillion",
         OLD."reservedMicroUsd", OLD."claimAuditLogId", OLD."createdAt") OR
     OLD."status" NOT IN ('in_flight', 'outcome_unknown', 'owner_consumed') OR
     (OLD."status" = 'outcome_unknown' AND
       NEW."status" NOT IN ('owner_consumed', 'released')) OR
     (OLD."status" = 'in_flight' AND NEW."status" NOT IN
       ('outcome_unknown', 'succeeded', 'failed')) OR
     (OLD."status" = 'owner_consumed' AND NEW."status" NOT IN
       ('succeeded', 'failed')) THEN
    RAISE EXCEPTION 'session budget claim transition refused' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."resolutionAuditLogId";
  IF OLD."status" = 'owner_consumed' THEN
    -- A late result is taken only for a claim the system closed unknown at
    -- zero, while it is the newest of its idea and was not stopped.
    SELECT * INTO closure_row FROM "AdminAuditLog" WHERE "id" = OLD."resolutionAuditLogId";
    IF OLD."budgetMode" IS DISTINCT FROM 'max_shadow' OR
       OLD."reservedMicroUsd" IS DISTINCT FROM 0 OR
       OLD."settledMicroUsd" IS DISTINCT FROM 0 OR
       closure_row."id" IS NULL OR closure_row."entryHash" IS NULL OR
       closure_row."action" IS DISTINCT FROM 'amux.v19.session_budget.resolved' OR
       closure_row."targetType" IS DISTINCT FROM 'AmuxIdeaSessionAnalysisBudgetClaim' OR
       closure_row."targetId" IS DISTINCT FROM OLD."id"::text OR
       closure_row."actorUserId" IS NOT NULL OR
       closure_row."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v4-intake' OR
       closure_row."metadata"->>'status' IS DISTINCT FROM 'owner_consumed' OR
       closure_row."metadata"->>'closedBy' IS DISTINCT FROM 'system' OR
       closure_row."metadata"->>'verification' IS DISTINCT FROM 'not_proven' OR
       audit_row."metadata"->>'previousResolutionAuditLogId' IS DISTINCT FROM
         OLD."resolutionAuditLogId" OR
       audit_row."metadata"->'lateAfterUnknown' IS DISTINCT FROM 'true'::jsonb OR
       EXISTS (SELECT 1 FROM "AmuxIdeaSessionAnalysisBudgetClaim" n
         WHERE n."reservationId" = OLD."reservationId" AND
           n."invocationOrdinal" > OLD."invocationOrdinal") OR
       EXISTS (SELECT 1 FROM "AdminAuditLog" s
         WHERE s."action" = 'amux.v19.session_analysis.stopped' AND
           s."targetType" = 'AmuxIdeaSessionAnalysisBudgetClaim' AND
           s."targetId" = OLD."id"::text) THEN
      RAISE EXCEPTION 'late session result refused' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF audit_row."id" IS NULL OR audit_row.xmin <> pg_current_xact_id()::xid OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" <> 'amux.v19.session_budget.resolved' OR
     audit_row."targetType" <> 'AmuxIdeaSessionAnalysisBudgetClaim' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
     audit_row."metadata"->>'status' IS DISTINCT FROM NEW."status" OR
     (OLD."status" = 'outcome_unknown' AND NOT (
       -- The owner's resolution in Admin.
       (audit_row."actorUserId" IS NOT NULL AND
        NOT COALESCE(audit_row."metadata" ? 'systemActor', false) AND
        audit_row."metadata"->>'verification' IS NOT DISTINCT FROM
          CASE WHEN NEW."status" = 'released'
            THEN 'proven_not_started' ELSE 'not_proven' END) OR
       -- The system's zero closure of a subscription claim.
       (NEW."status" = 'owner_consumed' AND OLD."budgetMode" = 'max_shadow' AND
        audit_row."actorUserId" IS NULL AND
        audit_row."metadata"->>'systemActor' IS NOT DISTINCT FROM 'amux-v4-intake' AND
        audit_row."metadata"->>'actorScope' IS NOT DISTINCT FROM 'session-budget-resolve-v1' AND
        audit_row."metadata"->>'closedBy' IS NOT DISTINCT FROM 'system' AND
        audit_row."metadata"->>'verification' IS NOT DISTINCT FROM 'not_proven'))) OR
     (OLD."status" <> 'outcome_unknown' AND
       (audit_row."actorUserId" IS NOT NULL OR
        audit_row."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v4-intake' OR
        audit_row."metadata"->>'actorScope' IS DISTINCT FROM 'session-budget-resolve-v1')) THEN
    RAISE EXCEPTION 'session budget resolution audit mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
