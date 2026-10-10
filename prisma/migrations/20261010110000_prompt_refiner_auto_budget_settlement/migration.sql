-- Add the only reviewed state machine for the Prompt Refiner product-Auto
-- cost hold. Unknown outcomes remain terminal and fully occupied; a future
-- reconciliation would need its own migration and authority.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "PromptRefinerAutoBudgetHold"
        WHERE "status" <> 'reserved'
    ) THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_legacy_transition_present';
    END IF;
END;
$$;

ALTER TABLE "PromptRefinerAutoBudgetHold"
    ADD COLUMN "dispatchIntentId" TEXT,
    ADD COLUMN "adapterConfigDigest" TEXT,
    ADD COLUMN "dispatchAuditLogId" TEXT,
    ADD COLUMN "dispatchedAt" TIMESTAMPTZ(3),
    ADD COLUMN "unknownObservationId" TEXT,
    ADD COLUMN "unknownAuditLogId" TEXT,
    ADD COLUMN "unknownAt" TIMESTAMPTZ(3),
    ADD COLUMN "settlementObservationId" TEXT,
    ADD COLUMN "releaseProofId" TEXT;

CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_dispatchIntentId_key"
    ON "PromptRefinerAutoBudgetHold"("dispatchIntentId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_dispatchAuditLogId_key"
    ON "PromptRefinerAutoBudgetHold"("dispatchAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_unknownObservationId_key"
    ON "PromptRefinerAutoBudgetHold"("unknownObservationId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_unknownAuditLogId_key"
    ON "PromptRefinerAutoBudgetHold"("unknownAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_settlementObservationId_key"
    ON "PromptRefinerAutoBudgetHold"("settlementObservationId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_releaseProofId_key"
    ON "PromptRefinerAutoBudgetHold"("releaseProofId");

ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_dispatchAuditLogId_fkey"
    FOREIGN KEY ("dispatchAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_unknownAuditLogId_fkey"
    FOREIGN KEY ("unknownAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

DROP TRIGGER "PromptRefinerAutoBudgetHold_no_update"
    ON "PromptRefinerAutoBudgetHold";
DROP FUNCTION prompt_refiner_auto_budget_hold_no_update();
DROP TRIGGER "PromptRefinerAutoBudgetWindow_update_guard"
    ON "PromptRefinerAutoBudgetWindow";
DROP FUNCTION prompt_refiner_auto_budget_window_update_guard();

ALTER TABLE "PromptRefinerAutoBudgetHold"
    DROP CONSTRAINT "PromptRefinerAutoBudgetHold_status_check";

ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_status_check" CHECK (
        ("status" = 'reserved' AND
         "dispatchIntentId" IS NULL AND "adapterConfigDigest" IS NULL AND
         "dispatchAuditLogId" IS NULL AND "dispatchedAt" IS NULL AND
         "unknownObservationId" IS NULL AND "unknownAuditLogId" IS NULL AND
         "unknownAt" IS NULL AND "settledMicroUsd" IS NULL AND
         "settlementObservationId" IS NULL AND "releaseProofId" IS NULL AND
         "settlementAuditLogId" IS NULL AND "closedAt" IS NULL) OR
        ("status" = 'dispatching' AND
         "dispatchIntentId" IS NOT NULL AND "adapterConfigDigest" IS NOT NULL AND
         "dispatchAuditLogId" IS NOT NULL AND "dispatchedAt" IS NOT NULL AND
         "unknownObservationId" IS NULL AND "unknownAuditLogId" IS NULL AND
         "unknownAt" IS NULL AND "settledMicroUsd" IS NULL AND
         "settlementObservationId" IS NULL AND "releaseProofId" IS NULL AND
         "settlementAuditLogId" IS NULL AND "closedAt" IS NULL) OR
        ("status" = 'unknown' AND
         "dispatchIntentId" IS NOT NULL AND "adapterConfigDigest" IS NOT NULL AND
         "dispatchAuditLogId" IS NOT NULL AND "dispatchedAt" IS NOT NULL AND
         "unknownObservationId" IS NOT NULL AND "unknownAuditLogId" IS NOT NULL AND
         "unknownAt" IS NOT NULL AND "settledMicroUsd" IS NULL AND
         "settlementObservationId" IS NULL AND "releaseProofId" IS NULL AND
         "settlementAuditLogId" IS NULL AND "closedAt" IS NULL) OR
        ("status" = 'settled' AND
         "dispatchIntentId" IS NOT NULL AND "adapterConfigDigest" IS NOT NULL AND
         "dispatchAuditLogId" IS NOT NULL AND "dispatchedAt" IS NOT NULL AND
         "unknownObservationId" IS NULL AND "unknownAuditLogId" IS NULL AND
         "unknownAt" IS NULL AND "settledMicroUsd" IS NOT NULL AND
         "settlementObservationId" IS NOT NULL AND "releaseProofId" IS NULL AND
         "settlementAuditLogId" IS NOT NULL AND "closedAt" IS NOT NULL) OR
        ("status" = 'released' AND
         (("dispatchIntentId" IS NULL AND "adapterConfigDigest" IS NULL AND
           "dispatchAuditLogId" IS NULL AND "dispatchedAt" IS NULL) OR
          ("dispatchIntentId" IS NOT NULL AND "adapterConfigDigest" IS NOT NULL AND
           "dispatchAuditLogId" IS NOT NULL AND "dispatchedAt" IS NOT NULL)) AND
         "unknownObservationId" IS NULL AND "unknownAuditLogId" IS NULL AND
         "unknownAt" IS NULL AND "settledMicroUsd" = 0 AND
         "settlementObservationId" IS NULL AND "releaseProofId" IS NOT NULL AND
         "settlementAuditLogId" IS NOT NULL AND "closedAt" IS NOT NULL)
    );

ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_transition_identity_check" CHECK (
        ("dispatchIntentId" IS NULL OR "dispatchIntentId" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
        ("adapterConfigDigest" IS NULL OR
            "adapterConfigDigest" ~ '^[0-9a-f]{64}$') AND
        ("unknownObservationId" IS NULL OR "unknownObservationId" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
        ("settlementObservationId" IS NULL OR "settlementObservationId" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AND
        ("releaseProofId" IS NULL OR "releaseProofId" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    );

CREATE FUNCTION prompt_refiner_auto_budget_hold_transition_guard() RETURNS trigger AS $$
DECLARE
    expected_day TIMESTAMPTZ(3);
    expected_month TIMESTAMPTZ(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        expected_day := date_trunc('day',
            transaction_timestamp() AT TIME ZONE 'Australia/Brisbane')
            AT TIME ZONE 'Australia/Brisbane';
        expected_month := date_trunc('month',
            transaction_timestamp() AT TIME ZONE 'Australia/Brisbane')
            AT TIME ZONE 'Australia/Brisbane';
        IF NEW."status" <> 'reserved' OR NEW."reservedMicroUsd" <> 29918 OR
           NEW."dayStart" <> expected_day OR NEW."monthStart" <> expected_month THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_reservation_invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW."id", NEW."requestKey", NEW."dayStart", NEW."monthStart",
           NEW."reservedMicroUsd", NEW."candidateDigest", NEW."pricePinDigest",
           NEW."runtimeDeploymentId", NEW."reservationAuditLogId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."requestKey", OLD."dayStart", OLD."monthStart",
           OLD."reservedMicroUsd", OLD."candidateDigest", OLD."pricePinDigest",
           OLD."runtimeDeploymentId", OLD."reservationAuditLogId", OLD."createdAt") THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_binding_immutable';
    END IF;

    IF OLD."status" = 'reserved' AND NEW."status" = 'dispatching' THEN
        NEW."dispatchedAt" := transaction_timestamp();
    ELSIF OLD."status" = 'dispatching' AND NEW."status" = 'unknown' THEN
        IF ROW(NEW."dispatchIntentId", NEW."adapterConfigDigest",
               NEW."dispatchAuditLogId", NEW."dispatchedAt") IS DISTINCT FROM
           ROW(OLD."dispatchIntentId", OLD."adapterConfigDigest",
               OLD."dispatchAuditLogId", OLD."dispatchedAt") THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_dispatch_binding_changed';
        END IF;
        NEW."unknownAt" := transaction_timestamp();
    ELSIF OLD."status" = 'dispatching' AND NEW."status" = 'settled' THEN
        IF ROW(NEW."dispatchIntentId", NEW."adapterConfigDigest",
               NEW."dispatchAuditLogId", NEW."dispatchedAt") IS DISTINCT FROM
           ROW(OLD."dispatchIntentId", OLD."adapterConfigDigest",
               OLD."dispatchAuditLogId", OLD."dispatchedAt") THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_dispatch_binding_changed';
        END IF;
        NEW."closedAt" := transaction_timestamp();
    ELSIF OLD."status" IN ('reserved', 'dispatching') AND NEW."status" = 'released' THEN
        IF ROW(NEW."dispatchIntentId", NEW."adapterConfigDigest",
               NEW."dispatchAuditLogId", NEW."dispatchedAt") IS DISTINCT FROM
           ROW(OLD."dispatchIntentId", OLD."adapterConfigDigest",
               OLD."dispatchAuditLogId", OLD."dispatchedAt") THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_dispatch_binding_changed';
        END IF;
        NEW."closedAt" := transaction_timestamp();
    ELSE
        RAISE EXCEPTION 'prompt_refiner_auto_budget_transition_invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every hold transition contributes one exact delta. Arithmetic updates are
-- deliberate: unlike recomputing SUM under a statement snapshot, they remain
-- correct when two reservations wait on the same window row. Day is always
-- locked before month.
CREATE FUNCTION prompt_refiner_auto_budget_apply_window_delta() RETURNS trigger AS $$
DECLARE
    amount_delta BIGINT;
    affected INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        amount_delta := NEW."reservedMicroUsd";
    ELSIF NEW."status" = 'settled' THEN
        amount_delta := NEW."settledMicroUsd" - OLD."reservedMicroUsd";
    ELSIF NEW."status" = 'released' THEN
        amount_delta := -OLD."reservedMicroUsd";
    ELSE
        RETURN NULL;
    END IF;

    IF amount_delta > 0 THEN
        INSERT INTO "PromptRefinerAutoBudgetWindow"
            ("period", "periodStart", "committedMicroUsd", "updatedAt")
        VALUES ('brisbane_day', NEW."dayStart", amount_delta, transaction_timestamp())
        ON CONFLICT ("period", "periodStart") DO UPDATE
          SET "committedMicroUsd" =
                "PromptRefinerAutoBudgetWindow"."committedMicroUsd" + amount_delta,
              "updatedAt" = transaction_timestamp()
          WHERE "PromptRefinerAutoBudgetWindow"."committedMicroUsd" <=
                100000000 - amount_delta;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_exhausted';
        END IF;
    ELSE
        UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = "committedMicroUsd" + amount_delta,
            "updatedAt" = transaction_timestamp()
        WHERE "period" = 'brisbane_day' AND "periodStart" = NEW."dayStart"
          AND "committedMicroUsd" + amount_delta >= 0;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_window_integrity_invalid';
        END IF;
    END IF;

    IF amount_delta > 0 THEN
        INSERT INTO "PromptRefinerAutoBudgetWindow"
            ("period", "periodStart", "committedMicroUsd", "updatedAt")
        VALUES ('brisbane_month', NEW."monthStart", amount_delta, transaction_timestamp())
        ON CONFLICT ("period", "periodStart") DO UPDATE
          SET "committedMicroUsd" =
                "PromptRefinerAutoBudgetWindow"."committedMicroUsd" + amount_delta,
              "updatedAt" = transaction_timestamp()
          WHERE "PromptRefinerAutoBudgetWindow"."committedMicroUsd" <=
                3000000000 - amount_delta;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_exhausted';
        END IF;
    ELSE
        UPDATE "PromptRefinerAutoBudgetWindow"
        SET "committedMicroUsd" = "committedMicroUsd" + amount_delta,
            "updatedAt" = transaction_timestamp()
        WHERE "period" = 'brisbane_month' AND "periodStart" = NEW."monthStart"
          AND "committedMicroUsd" + amount_delta >= 0;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN
            RAISE EXCEPTION 'prompt_refiner_auto_budget_window_integrity_invalid';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prompt_refiner_auto_budget_window_exact_guard() RETURNS trigger AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_window_direct_write_forbidden';
    END IF;
    IF TG_OP = 'UPDATE' AND
       (NEW."period" IS DISTINCT FROM OLD."period" OR
        NEW."periodStart" IS DISTINCT FROM OLD."periodStart") THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_window_total_invalid';
    END IF;
    NEW."updatedAt" := transaction_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rebuild the previously reserve-only windows from their immutable holds before
-- closing direct writes. Any over-cap historical state fails this migration.
UPDATE "PromptRefinerAutoBudgetWindow" AS budget_window
SET "committedMicroUsd" = COALESCE((
        SELECT SUM(hold."reservedMicroUsd")
        FROM "PromptRefinerAutoBudgetHold" AS hold
        WHERE (budget_window."period" = 'brisbane_day' AND
               hold."dayStart" = budget_window."periodStart") OR
              (budget_window."period" = 'brisbane_month' AND
               hold."monthStart" = budget_window."periodStart")
    ), 0),
    "updatedAt" = transaction_timestamp();

INSERT INTO "PromptRefinerAutoBudgetWindow"
    ("period", "periodStart", "committedMicroUsd", "updatedAt")
SELECT period, period_start, SUM(amount), transaction_timestamp()
FROM (
    SELECT 'brisbane_day'::TEXT AS period, "dayStart" AS period_start,
           "reservedMicroUsd" AS amount
    FROM "PromptRefinerAutoBudgetHold"
    UNION ALL
    SELECT 'brisbane_month'::TEXT, "monthStart", "reservedMicroUsd"
    FROM "PromptRefinerAutoBudgetHold"
) AS holds
GROUP BY period, period_start
ON CONFLICT ("period", "periodStart") DO NOTHING;

CREATE TRIGGER "PromptRefinerAutoBudgetHold_transition_guard"
    BEFORE INSERT OR UPDATE ON "PromptRefinerAutoBudgetHold"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_hold_transition_guard();
CREATE TRIGGER "PromptRefinerAutoBudgetHold_apply_window_delta"
    AFTER INSERT OR UPDATE OF "status" ON "PromptRefinerAutoBudgetHold"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_apply_window_delta();
CREATE TRIGGER "PromptRefinerAutoBudgetWindow_exact_guard"
    BEFORE INSERT OR UPDATE ON "PromptRefinerAutoBudgetWindow"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_window_exact_guard();
