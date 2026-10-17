-- v19 session analysis uses the existing owner-managed agent/amux-intake
-- monthly window. This migration creates no claim and starts no CLI.
BEGIN;

CREATE TABLE "AmuxIdeaSessionAnalysisBudgetClaim" (
  "id" UUID NOT NULL PRIMARY KEY,
  "reservationId" UUID NOT NULL,
  "invocationOrdinal" INTEGER NOT NULL,
  "requestId" UUID NOT NULL UNIQUE,
  "namespace" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3) NOT NULL,
  "priceVersionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "inputTokensCap" INTEGER NOT NULL,
  "outputTokensCap" INTEGER NOT NULL,
  "inputMicroUsdPerMillion" INTEGER NOT NULL,
  "outputMicroUsdPerMillion" INTEGER NOT NULL,
  "reservedMicroUsd" BIGINT NOT NULL,
  "settledMicroUsd" BIGINT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "status" TEXT NOT NULL,
  "claimAuditLogId" TEXT NOT NULL UNIQUE,
  "resolutionAuditLogId" TEXT UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_namespace_check"
    CHECK ("namespace" = 'agent/amux-intake'),
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check" CHECK (
    "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
    "invocationOrdinal" >= 0 AND
    "inputMicroUsdPerMillion" > 0 AND "outputMicroUsdPerMillion" > 0 AND
    "reservedMicroUsd" > 0 AND
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
      "settledMicroUsd" BETWEEN 0 AND "reservedMicroUsd" AND
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
  ),
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_reservation_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "AmuxIdeaSessionAnalysisReservation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_window_fkey"
    FOREIGN KEY ("namespace", "monthStart")
    REFERENCES "AmuxIdeaAnalysisBudgetWindow"("namespace", "monthStart")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_price_fkey"
    FOREIGN KEY ("priceVersionId") REFERENCES "AmuxIdeaAnalysisPriceVersion"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_claim_audit_fkey"
    FOREIGN KEY ("claimAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_resolution_audit_fkey"
    FOREIGN KEY ("resolutionAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "AmuxIdeaSessionAnalysisBudgetClaim_window_status_idx"
  ON "AmuxIdeaSessionAnalysisBudgetClaim"("namespace", "monthStart", "status");
CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisBudgetClaim_reservation_ordinal_key"
  ON "AmuxIdeaSessionAnalysisBudgetClaim"("reservationId", "invocationOrdinal");

CREATE FUNCTION "amux_v19_session_budget_claim_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE audit_row record; reservation_row record; price_row record;
  window_row record; prior_claim_row record;
  outstanding_v4 numeric; outstanding_session numeric;
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
    SELECT "invocationOrdinal", "status" INTO prior_claim_row
      FROM "AmuxIdeaSessionAnalysisBudgetClaim"
      WHERE "reservationId" = NEW."reservationId"
      ORDER BY "invocationOrdinal" DESC LIMIT 1;
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
         (CASE WHEN NEW."invocationOrdinal" = 0
           THEN 'submitted' ELSE 'analyzing' END) OR
       (NEW."invocationOrdinal" = 0 AND prior_claim_row."status" IS NOT NULL) OR
       (NEW."invocationOrdinal" > 0 AND
         (prior_claim_row."status" IS DISTINCT FROM 'succeeded' OR
          prior_claim_row."invocationOrdinal" IS DISTINCT FROM
            NEW."invocationOrdinal" - 1)) OR
       reservation_row."modelProvider" IS DISTINCT FROM NEW."provider" OR
       reservation_row."modelId" IS DISTINCT FROM NEW."modelId" OR
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
           NEW."inputMicroUsdPerMillion", NEW."outputMicroUsdPerMillion") OR
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
     OLD."status" NOT IN ('in_flight', 'outcome_unknown') OR
     (OLD."status" = 'outcome_unknown' AND
       NEW."status" NOT IN ('owner_consumed', 'released')) OR
     (OLD."status" = 'in_flight' AND NEW."status" NOT IN
       ('outcome_unknown', 'succeeded', 'failed')) THEN
    RAISE EXCEPTION 'session budget claim transition refused' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."resolutionAuditLogId";
  IF NOT FOUND OR audit_row.xmin <> pg_current_xact_id()::xid OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" <> 'amux.v19.session_budget.resolved' OR
     audit_row."targetType" <> 'AmuxIdeaSessionAnalysisBudgetClaim' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
     audit_row."metadata"->>'status' IS DISTINCT FROM NEW."status" OR
     (OLD."status" = 'outcome_unknown' AND
       (audit_row."actorUserId" IS NULL OR
        audit_row."metadata" ? 'systemActor' OR
        audit_row."metadata"->>'verification' IS DISTINCT FROM
          CASE WHEN NEW."status" = 'released'
            THEN 'proven_not_started' ELSE 'not_proven' END)) OR
     (OLD."status" <> 'outcome_unknown' AND
       (audit_row."actorUserId" IS NOT NULL OR
        audit_row."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v4-intake' OR
        audit_row."metadata"->>'actorScope' IS DISTINCT FROM 'session-budget-resolve-v1')) THEN
    RAISE EXCEPTION 'session budget resolution audit mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaSessionAnalysisBudgetClaim_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaSessionAnalysisBudgetClaim"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_budget_claim_guard"();

COMMIT;
