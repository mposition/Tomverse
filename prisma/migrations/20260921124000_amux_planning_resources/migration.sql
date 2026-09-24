-- Durable AMUX planning facts and policy-controlled operational limits.
-- No numeric policy is invented by this migration: NULL means unconfigured.

CREATE TABLE "AmuxResourcePolicy" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "wipLimit" INTEGER,
    "capacityPoints" INTEGER,
    "costBudgetMicrousd" BIGINT,
    "budgetWindowStartsAt" TIMESTAMP(3),
    "budgetWindowEndsAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxResourcePolicy_pkey" PRIMARY KEY ("scope", "key"),
    CONSTRAINT "AmuxResourcePolicy_scope_check"
      CHECK ("scope" IN ('project', 'team')),
    CONSTRAINT "AmuxResourcePolicy_key_check"
      CHECK ("key" ~ '^[A-Za-z0-9._:-]{1,80}$'),
    CONSTRAINT "AmuxResourcePolicy_wip_limit_check"
      CHECK ("wipLimit" IS NULL OR "wipLimit" BETWEEN 1 AND 10000),
    CONSTRAINT "AmuxResourcePolicy_capacity_points_check"
      CHECK ("capacityPoints" IS NULL OR "capacityPoints" BETWEEN 1 AND 1000000),
    CONSTRAINT "AmuxResourcePolicy_cost_budget_check"
      CHECK ("costBudgetMicrousd" IS NULL OR "costBudgetMicrousd" > 0),
    CONSTRAINT "AmuxResourcePolicy_budget_window_check"
      CHECK (
        ("costBudgetMicrousd" IS NULL AND "budgetWindowStartsAt" IS NULL AND "budgetWindowEndsAt" IS NULL)
        OR
        ("costBudgetMicrousd" IS NOT NULL AND "budgetWindowStartsAt" IS NOT NULL AND "budgetWindowEndsAt" IS NOT NULL AND "budgetWindowStartsAt" < "budgetWindowEndsAt")
      )
);

CREATE INDEX "AmuxResourcePolicy_active_scope_idx"
  ON "AmuxResourcePolicy"("active", "scope");
CREATE INDEX "AmuxResourcePolicy_budgetWindowEndsAt_idx"
  ON "AmuxResourcePolicy"("budgetWindowEndsAt");

ALTER TABLE "AmuxWorkItem"
  ADD COLUMN "projectKey" TEXT,
  ADD COLUMN "teamKey" TEXT,
  ADD COLUMN "dueAt" TIMESTAMP(3),
  ADD COLUMN "duePrecision" TEXT,
  ADD COLUMN "dueSource" TEXT,
  ADD COLUMN "dueParseState" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "dueRaw" TEXT,
  ADD COLUMN "effortPoints" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "estimatedCostMicrousd" BIGINT,
  ADD COLUMN "requiredRoutingRole" TEXT,
  ADD COLUMN "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewSpecialty" TEXT;

ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_due_precision_check"
    CHECK ("duePrecision" IS NULL OR "duePrecision" IN ('date', 'instant')),
  ADD CONSTRAINT "AmuxWorkItem_due_source_check"
    CHECK ("dueSource" IS NULL OR "dueSource" IN ('classification', 'title', 'description')),
  ADD CONSTRAINT "AmuxWorkItem_due_parse_state_check"
    CHECK ("dueParseState" IN ('none', 'valid', 'invalid', 'ambiguous')),
  ADD CONSTRAINT "AmuxWorkItem_due_shape_check"
    CHECK (
      ("dueParseState" = 'none' AND "dueAt" IS NULL AND "duePrecision" IS NULL AND "dueSource" IS NULL AND "dueRaw" IS NULL)
      OR
      ("dueParseState" = 'valid' AND "dueAt" IS NOT NULL AND "duePrecision" IS NOT NULL AND "dueSource" IS NOT NULL AND "dueRaw" IS NOT NULL)
      OR
      ("dueParseState" = 'invalid' AND "dueAt" IS NULL AND "duePrecision" IS NULL AND "dueSource" IS NOT NULL AND "dueRaw" IS NOT NULL)
      OR
      ("dueParseState" = 'ambiguous' AND "dueAt" IS NULL AND "duePrecision" IS NULL AND "dueSource" IS NULL AND "dueRaw" IS NOT NULL)
    ),
  ADD CONSTRAINT "AmuxWorkItem_effort_points_check"
    CHECK ("effortPoints" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "AmuxWorkItem_estimated_cost_check"
    CHECK ("estimatedCostMicrousd" IS NULL OR "estimatedCostMicrousd" >= 0),
  ADD CONSTRAINT "AmuxWorkItem_planning_key_check"
    CHECK (
      ("projectKey" IS NULL OR "projectKey" ~ '^[A-Za-z0-9._:-]{1,80}$')
      AND ("teamKey" IS NULL OR "teamKey" ~ '^[A-Za-z0-9._:-]{1,80}$')
      AND ("requiredRoutingRole" IS NULL OR "requiredRoutingRole" ~ '^[A-Za-z0-9_:-]{1,64}$')
      AND ("reviewSpecialty" IS NULL OR "reviewSpecialty" ~ '^[A-Za-z0-9_:-]{1,64}$')
    ),
  ADD CONSTRAINT "AmuxWorkItem_human_review_shape_check"
    CHECK (
      ("requiresHumanReview" AND "reviewSpecialty" IS NOT NULL)
      OR (NOT "requiresHumanReview" AND "reviewSpecialty" IS NULL)
    );

CREATE INDEX "AmuxWorkItem_projectKey_status_owner_idx"
  ON "AmuxWorkItem"("projectKey", "status", "owner");
CREATE INDEX "AmuxWorkItem_teamKey_status_owner_idx"
  ON "AmuxWorkItem"("teamKey", "status", "owner");
CREATE INDEX "AmuxWorkItem_dueAt_status_idx"
  ON "AmuxWorkItem"("dueAt", "status");

ALTER TABLE "AmuxExecutionAttempt"
  ADD COLUMN "reservedCostMicrousd" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "settledCostMicrousd" BIGINT,
  ADD COLUMN "costConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AmuxExecutionAttempt"
  ADD CONSTRAINT "AmuxExecutionAttempt_cost_check"
    CHECK (
      "reservedCostMicrousd" >= 0
      AND ("settledCostMicrousd" IS NULL OR "settledCostMicrousd" >= 0)
      AND (NOT "costConfirmed" OR "settledCostMicrousd" IS NOT NULL)
    );

CREATE TABLE "AmuxCostLedgerEntry" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "budgetWindowStartsAt" TIMESTAMP(3) NOT NULL,
    "budgetWindowEndsAt" TIMESTAMP(3) NOT NULL,
    "taskId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMicrousd" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxCostLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxCostLedgerEntry_scope_check"
      CHECK ("scope" IN ('project', 'team')),
    CONSTRAINT "AmuxCostLedgerEntry_kind_check"
      CHECK ("kind" IN ('reservation', 'settlement_delta')),
    CONSTRAINT "AmuxCostLedgerEntry_amount_check"
      CHECK (
        ("kind" = 'reservation' AND "amountMicrousd" >= 0)
        OR "kind" = 'settlement_delta'
      ),
    CONSTRAINT "AmuxCostLedgerEntry_budget_window_check"
      CHECK ("budgetWindowStartsAt" < "budgetWindowEndsAt")
);

ALTER TABLE "AmuxCostLedgerEntry"
  ADD CONSTRAINT "AmuxCostLedgerEntry_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AmuxCostLedgerEntry"
  ADD CONSTRAINT "AmuxCostLedgerEntry_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AmuxCostLedgerEntry_attemptId_scope_resourceKey_kind_key"
  ON "AmuxCostLedgerEntry"("attemptId", "scope", "resourceKey", "kind");
CREATE INDEX "AmuxCostLedgerEntry_scope_resourceKey_budgetWindowStartsAt__idx"
  ON "AmuxCostLedgerEntry"("scope", "resourceKey", "budgetWindowStartsAt", "budgetWindowEndsAt");
CREATE INDEX "AmuxCostLedgerEntry_taskId_createdAt_idx"
  ON "AmuxCostLedgerEntry"("taskId", "createdAt");

CREATE FUNCTION amux_cost_ledger_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AmuxCostLedgerEntry is append-only'; END;
$$;
CREATE TRIGGER "AmuxCostLedgerEntry_reject_update"
BEFORE UPDATE ON "AmuxCostLedgerEntry" FOR EACH ROW
EXECUTE FUNCTION amux_cost_ledger_append_only_guard();
CREATE TRIGGER "AmuxCostLedgerEntry_reject_delete"
BEFORE DELETE ON "AmuxCostLedgerEntry" FOR EACH ROW
EXECUTE FUNCTION amux_cost_ledger_append_only_guard();

CREATE TABLE "AmuxQuotaObservation" (
    "id" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "remainingBasisPoints" INTEGER NOT NULL,
    "confidenceBasisPoints" INTEGER NOT NULL,
    "exhausted" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "resetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxQuotaObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxQuotaObservation_remaining_check"
      CHECK ("remainingBasisPoints" BETWEEN 0 AND 10000),
    CONSTRAINT "AmuxQuotaObservation_confidence_check"
      CHECK ("confidenceBasisPoints" BETWEEN 0 AND 10000),
    CONSTRAINT "AmuxQuotaObservation_source_check"
      CHECK ("source" IN ('provider_api', 'wrapper')),
    CONSTRAINT "AmuxQuotaObservation_time_check"
      CHECK ("resetAt" IS NULL OR "resetAt" > "observedAt")
);
CREATE INDEX "AmuxQuotaObservation_worker_observedAt_idx"
  ON "AmuxQuotaObservation"("worker", "observedAt");
CREATE INDEX "AmuxQuotaObservation_provider_observedAt_idx"
  ON "AmuxQuotaObservation"("provider", "observedAt");
CREATE INDEX "AmuxQuotaObservation_createdAt_idx"
  ON "AmuxQuotaObservation"("createdAt");

CREATE FUNCTION amux_quota_observation_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD."createdAt" <= clock_timestamp() - INTERVAL '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AmuxQuotaObservation is append-only inside its 90-day evidence window';
END;
$$;
CREATE TRIGGER "AmuxQuotaObservation_reject_update"
BEFORE UPDATE ON "AmuxQuotaObservation" FOR EACH ROW
EXECUTE FUNCTION amux_quota_observation_append_only_guard();
CREATE TRIGGER "AmuxQuotaObservation_reject_delete"
BEFORE DELETE ON "AmuxQuotaObservation" FOR EACH ROW
EXECUTE FUNCTION amux_quota_observation_append_only_guard();

CREATE TABLE "AmuxHumanEscalation" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "specialty" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedBy" TEXT NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedByEmail" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedByEmail" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxHumanEscalation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxHumanEscalation_status_check"
      CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
    CONSTRAINT "AmuxHumanEscalation_lifecycle_check"
      CHECK (
        ("status" = 'open' AND "acknowledgedAt" IS NULL AND "resolvedAt" IS NULL)
        OR
        ("status" = 'acknowledged' AND "acknowledgedAt" IS NOT NULL AND "acknowledgedById" IS NOT NULL AND "resolvedAt" IS NULL)
        OR
        ("status" = 'resolved' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolution" IS NOT NULL)
      )
);
ALTER TABLE "AmuxHumanEscalation"
  ADD CONSTRAINT "AmuxHumanEscalation_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "AmuxHumanEscalation_status_createdAt_idx"
  ON "AmuxHumanEscalation"("status", "createdAt");
CREATE INDEX "AmuxHumanEscalation_taskId_createdAt_idx"
  ON "AmuxHumanEscalation"("taskId", "createdAt");
CREATE INDEX "AmuxHumanEscalation_specialty_status_idx"
  ON "AmuxHumanEscalation"("specialty", "status");
CREATE UNIQUE INDEX "AmuxHumanEscalation_one_open_per_task"
  ON "AmuxHumanEscalation"("taskId")
  WHERE "status" IN ('open', 'acknowledged');
