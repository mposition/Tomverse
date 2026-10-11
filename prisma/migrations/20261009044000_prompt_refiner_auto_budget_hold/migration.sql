-- Product Auto budget holds are dark until the separately gated adapter is
-- enabled. A separate window table keeps product spend out of Chat credits and
-- provider budgets; the hold makes unknown exposure durable and non-retryable.
CREATE TABLE "PromptRefinerAutoBudgetWindow" (
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "committedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PromptRefinerAutoBudgetWindow_pkey" PRIMARY KEY ("period", "periodStart"),
    CONSTRAINT "PromptRefinerAutoBudgetWindow_period_check"
        CHECK ("period" IN ('brisbane_day', 'brisbane_month')),
    CONSTRAINT "PromptRefinerAutoBudgetWindow_amount_check"
        CHECK (("period" = 'brisbane_day' AND
                "committedMicroUsd" BETWEEN 0 AND 100000000) OR
               ("period" = 'brisbane_month' AND
                "committedMicroUsd" BETWEEN 0 AND 3000000000))
);

CREATE TABLE "PromptRefinerAutoBudgetHold" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "dayStart" TIMESTAMPTZ(3) NOT NULL,
    "monthStart" TIMESTAMPTZ(3) NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "settledMicroUsd" BIGINT,
    "status" TEXT NOT NULL,
    "candidateDigest" TEXT NOT NULL,
    "pricePinDigest" TEXT NOT NULL,
    "runtimeDeploymentId" TEXT NOT NULL,
    "reservationAuditLogId" TEXT NOT NULL,
    "settlementAuditLogId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PromptRefinerAutoBudgetHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerAutoBudgetHold_request_key_check"
        CHECK ("requestKey" ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "PromptRefinerAutoBudgetHold_amount_check"
        CHECK ("reservedMicroUsd" BETWEEN 1 AND 29918 AND
               ("settledMicroUsd" IS NULL OR
                "settledMicroUsd" BETWEEN 0 AND "reservedMicroUsd")),
    CONSTRAINT "PromptRefinerAutoBudgetHold_status_check"
        CHECK (("status" IN ('reserved', 'dispatching', 'unknown') AND
                "settledMicroUsd" IS NULL AND "settlementAuditLogId" IS NULL AND
                "closedAt" IS NULL) OR
               ("status" IN ('settled', 'released') AND
                "settledMicroUsd" IS NOT NULL AND
                "settlementAuditLogId" IS NOT NULL AND "closedAt" IS NOT NULL AND
                ("status" <> 'released' OR "settledMicroUsd" = 0))),
    CONSTRAINT "PromptRefinerAutoBudgetHold_candidate_digest_check"
        CHECK ("candidateDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerAutoBudgetHold_price_digest_check"
        CHECK ("pricePinDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerAutoBudgetHold_deployment_check"
        CHECK ("runtimeDeploymentId" ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_requestKey_key"
    ON "PromptRefinerAutoBudgetHold"("requestKey");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_reservationAuditLogId_key"
    ON "PromptRefinerAutoBudgetHold"("reservationAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerAutoBudgetHold_settlementAuditLogId_key"
    ON "PromptRefinerAutoBudgetHold"("settlementAuditLogId");
CREATE INDEX "PromptRefinerAutoBudgetHold_status_createdAt_idx"
    ON "PromptRefinerAutoBudgetHold"("status", "createdAt");
CREATE INDEX "PromptRefinerAutoBudgetHold_dayStart_idx"
    ON "PromptRefinerAutoBudgetHold"("dayStart");
CREATE INDEX "PromptRefinerAutoBudgetHold_monthStart_idx"
    ON "PromptRefinerAutoBudgetHold"("monthStart");

ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_reservationAuditLogId_fkey"
    FOREIGN KEY ("reservationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PromptRefinerAutoBudgetHold" ADD CONSTRAINT
    "PromptRefinerAutoBudgetHold_settlementAuditLogId_fkey"
    FOREIGN KEY ("settlementAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION prompt_refiner_auto_budget_no_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'prompt_refiner_auto_budget_delete_forbidden';
END;
$$ LANGUAGE plpgsql;

-- Existing test suites reset AdminAuditLog with TRUNCATE CASCADE. Allow that
-- cleanup only while this new dark ledger has no rows; real holds stay intact.
CREATE FUNCTION prompt_refiner_auto_budget_window_no_nonempty_truncate() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "PromptRefinerAutoBudgetWindow") THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_delete_forbidden';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prompt_refiner_auto_budget_hold_no_nonempty_truncate() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "PromptRefinerAutoBudgetHold") THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_delete_forbidden';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- This dark first slice has no settlement writer. A later reviewed migration
-- must introduce exact audited transitions before product dispatch is enabled.
CREATE FUNCTION prompt_refiner_auto_budget_hold_no_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'prompt_refiner_auto_budget_hold_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prompt_refiner_auto_budget_window_update_guard() RETURNS trigger AS $$
BEGIN
    IF NEW."period" IS DISTINCT FROM OLD."period" OR
       NEW."periodStart" IS DISTINCT FROM OLD."periodStart" OR
       NEW."committedMicroUsd" <> OLD."committedMicroUsd" + 29918 THEN
        RAISE EXCEPTION 'prompt_refiner_auto_budget_window_update_invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PromptRefinerAutoBudgetWindow_no_delete"
    BEFORE DELETE ON "PromptRefinerAutoBudgetWindow"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_no_delete();
CREATE TRIGGER "PromptRefinerAutoBudgetWindow_no_truncate"
    BEFORE TRUNCATE ON "PromptRefinerAutoBudgetWindow"
    FOR EACH STATEMENT EXECUTE FUNCTION prompt_refiner_auto_budget_window_no_nonempty_truncate();
CREATE TRIGGER "PromptRefinerAutoBudgetWindow_update_guard"
    BEFORE UPDATE ON "PromptRefinerAutoBudgetWindow"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_window_update_guard();
CREATE TRIGGER "PromptRefinerAutoBudgetHold_no_delete"
    BEFORE DELETE ON "PromptRefinerAutoBudgetHold"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_no_delete();
CREATE TRIGGER "PromptRefinerAutoBudgetHold_no_truncate"
    BEFORE TRUNCATE ON "PromptRefinerAutoBudgetHold"
    FOR EACH STATEMENT EXECUTE FUNCTION prompt_refiner_auto_budget_hold_no_nonempty_truncate();
CREATE TRIGGER "PromptRefinerAutoBudgetHold_no_update"
    BEFORE UPDATE ON "PromptRefinerAutoBudgetHold"
    FOR EACH ROW EXECUTE FUNCTION prompt_refiner_auto_budget_hold_no_update();
