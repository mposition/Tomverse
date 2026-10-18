-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerCostPlan" (
    "id" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "registrationDigest" TEXT NOT NULL,
    "planDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "sourceApprovalTarget" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "priceSetDigest" TEXT NOT NULL,
    "wholePlanQuotedMicroUsd" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "activationDigest" TEXT NOT NULL,
    "activationAuditLogId" TEXT NOT NULL,
    "registrationAuditLogId" TEXT NOT NULL,
    "externalDispatchAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminalAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatUnifiedOptimizerCostPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerCostRun" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "optimizerRunId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "quoteDigest" TEXT NOT NULL,
    "corpusSlotId" UUID NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "quotedMicroUsd" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "terminalAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatUnifiedOptimizerCostRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerQuotaContract" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "bindingDigest" TEXT NOT NULL,
    "quotaContractDigest" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "billingMode" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "measurementState" TEXT NOT NULL,
    "afterReadbackRequired" BOOLEAN NOT NULL,
    "callsPerRunCap" INTEGER NOT NULL,
    "inputTokensPerRunCap" INTEGER,
    "outputTokensPerRunCap" INTEGER,
    "provenanceDigest" TEXT NOT NULL,
    "provenanceObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "provenanceExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUnifiedOptimizerQuotaContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerCostCall" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "quotaContractId" UUID NOT NULL,
    "optimizerRoleJobId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "billingMode" TEXT NOT NULL,
    "costMeaning" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "bindingDigest" TEXT NOT NULL,
    "priceSetDigest" TEXT NOT NULL,
    "priceQuoteDigest" TEXT NOT NULL,
    "priceVerifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "priceExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "calls" INTEGER NOT NULL,
    "inputTokensCapPerCall" INTEGER NOT NULL,
    "outputTokensCapPerCall" INTEGER NOT NULL,
    "worstCaseMicroUsdPerCall" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUnifiedOptimizerCostCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerCostWindow" (
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "committedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatUnifiedOptimizerCostWindow_pkey" PRIMARY KEY ("period","periodStart")
);

-- CreateTable
CREATE TABLE "ChatUnifiedOptimizerDispatchHold" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "callBucketId" UUID NOT NULL,
    "invocationOrdinal" INTEGER NOT NULL,
    "reservationRequestId" UUID NOT NULL,
    "reservationRequestDigest" TEXT NOT NULL,
    "intentId" UUID NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "settledMicroUsd" BIGINT,
    "settledInputTokens" INTEGER,
    "settledOutputTokens" INTEGER,
    "inputTokensCap" INTEGER NOT NULL,
    "outputTokensCap" INTEGER NOT NULL,
    "dayStart" TIMESTAMPTZ(3) NOT NULL,
    "monthStart" TIMESTAMPTZ(3) NOT NULL,
    "preQuotaObservationDigest" TEXT NOT NULL,
    "preQuotaObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "preQuotaExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "preQuotaCallsRemaining" INTEGER NOT NULL,
    "preQuotaInputTokensRemaining" INTEGER,
    "preQuotaOutputTokensRemaining" INTEGER,
    "state" TEXT NOT NULL,
    "terminalRequestId" UUID,
    "terminalRequestDigest" TEXT,
    "terminalObservationDigest" TEXT,
    "afterQuotaObservedAt" TIMESTAMPTZ(3),
    "afterQuotaExpiresAt" TIMESTAMPTZ(3),
    "afterQuotaCallsRemaining" INTEGER,
    "afterQuotaInputTokensRemaining" INTEGER,
    "afterQuotaOutputTokensRemaining" INTEGER,
    "reservationAuditLogId" TEXT NOT NULL,
    "intentAuditLogId" TEXT NOT NULL,
    "terminalAuditLogId" TEXT,
    "externalDispatchAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminalAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatUnifiedOptimizerDispatchHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostPlan_requestId_key" ON "ChatUnifiedOptimizerCostPlan"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostPlan_registrationDigest_key" ON "ChatUnifiedOptimizerCostPlan"("registrationDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostPlan_activationAuditLogId_key" ON "ChatUnifiedOptimizerCostPlan"("activationAuditLogId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostPlan_registrationAuditLogId_key" ON "ChatUnifiedOptimizerCostPlan"("registrationAuditLogId");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerCostPlan_state_createdAt_idx" ON "ChatUnifiedOptimizerCostPlan"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostRun_corpusSlotId_key" ON "ChatUnifiedOptimizerCostRun"("corpusSlotId");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerCostRun_planId_state_idx" ON "ChatUnifiedOptimizerCostRun"("planId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostRun_planId_ordinal_key" ON "ChatUnifiedOptimizerCostRun"("planId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostRun_planId_quoteDigest_key" ON "ChatUnifiedOptimizerCostRun"("planId", "quoteDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerQuotaContract_planId_bindingDigest_key" ON "ChatUnifiedOptimizerQuotaContract"("planId", "bindingDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerQuotaContract_planId_quotaContractDiges_key" ON "ChatUnifiedOptimizerQuotaContract"("planId", "quotaContractDigest");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerCostCall_planId_bindingDigest_idx" ON "ChatUnifiedOptimizerCostCall"("planId", "bindingDigest");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerCostCall_runId_idx" ON "ChatUnifiedOptimizerCostCall"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_reservationRequestId_key" ON "ChatUnifiedOptimizerDispatchHold"("reservationRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_intentId_key" ON "ChatUnifiedOptimizerDispatchHold"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_terminalRequestId_key" ON "ChatUnifiedOptimizerDispatchHold"("terminalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_reservationAuditLogId_key" ON "ChatUnifiedOptimizerDispatchHold"("reservationAuditLogId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_intentAuditLogId_key" ON "ChatUnifiedOptimizerDispatchHold"("intentAuditLogId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_terminalAuditLogId_key" ON "ChatUnifiedOptimizerDispatchHold"("terminalAuditLogId");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerDispatchHold_planId_state_idx" ON "ChatUnifiedOptimizerDispatchHold"("planId", "state");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerDispatchHold_runId_state_idx" ON "ChatUnifiedOptimizerDispatchHold"("runId", "state");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerDispatchHold_dayStart_state_idx" ON "ChatUnifiedOptimizerDispatchHold"("dayStart", "state");

-- CreateIndex
CREATE INDEX "ChatUnifiedOptimizerDispatchHold_monthStart_state_idx" ON "ChatUnifiedOptimizerDispatchHold"("monthStart", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUnifiedOptimizerDispatchHold_callBucketId_invocationOrd_key" ON "ChatUnifiedOptimizerDispatchHold"("callBucketId", "invocationOrdinal");

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostPlan" ADD CONSTRAINT "ChatUnifiedOptimizerCostPlan_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostPlan" ADD CONSTRAINT "ChatUnifiedOptimizerCostPlan_activationAuditLogId_fkey" FOREIGN KEY ("activationAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostPlan" ADD CONSTRAINT "ChatUnifiedOptimizerCostPlan_registrationAuditLogId_fkey" FOREIGN KEY ("registrationAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostRun" ADD CONSTRAINT "ChatUnifiedOptimizerCostRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ChatUnifiedOptimizerCostPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostRun" ADD CONSTRAINT "ChatUnifiedOptimizerCostRun_optimizerRunId_fkey" FOREIGN KEY ("optimizerRunId") REFERENCES "ChatUnifiedOptimizerRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerQuotaContract" ADD CONSTRAINT "ChatUnifiedOptimizerQuotaContract_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ChatUnifiedOptimizerCostPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostCall" ADD CONSTRAINT "ChatUnifiedOptimizerCostCall_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ChatUnifiedOptimizerCostPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostCall" ADD CONSTRAINT "ChatUnifiedOptimizerCostCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChatUnifiedOptimizerCostRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostCall" ADD CONSTRAINT "ChatUnifiedOptimizerCostCall_quotaContractId_fkey" FOREIGN KEY ("quotaContractId") REFERENCES "ChatUnifiedOptimizerQuotaContract"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerCostCall" ADD CONSTRAINT "ChatUnifiedOptimizerCostCall_optimizerRoleJobId_fkey" FOREIGN KEY ("optimizerRoleJobId") REFERENCES "ChatUnifiedOptimizerRoleJob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ChatUnifiedOptimizerCostPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChatUnifiedOptimizerCostRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_callBucketId_fkey" FOREIGN KEY ("callBucketId") REFERENCES "ChatUnifiedOptimizerCostCall"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_reservationAuditLogId_fkey" FOREIGN KEY ("reservationAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_intentAuditLogId_fkey" FOREIGN KEY ("intentAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT "ChatUnifiedOptimizerDispatchHold_terminalAuditLogId_fkey" FOREIGN KEY ("terminalAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- U19 is a content-free cost/quota ledger. These database checks keep the
-- separate agent-cost namespace closed even if application validation is
-- bypassed. Reservation/intent rows never confer external dispatch authority.
ALTER TABLE "ChatUnifiedOptimizerCostPlan" ADD CONSTRAINT
  "ChatUnifiedOptimizerCostPlan_closed_check" CHECK (
    "policyVersion" = 1
    AND "purpose" IN ('s0_probe', 'normal_cycle')
    AND "registrationDigest" ~ '^[0-9a-f]{64}$'
    AND "planDigest" ~ '^[0-9a-f]{64}$'
    AND "sourceApprovalTarget" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND position('..' in "sourceApprovalTarget") = 0
    AND "baseSha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "priceSetDigest" ~ '^[0-9a-f]{64}$'
    AND "activationDigest" ~ '^[0-9a-f]{64}$'
    AND "wholePlanQuotedMicroUsd" BETWEEN 0 AND 75000000
    AND "state" IN ('active', 'succeeded', 'stopped_unknown',
      'stopped_overrun', 'stopped_late')
    AND NOT "externalDispatchAuthorized"
    AND (("state" = 'active' AND "terminalAt" IS NULL)
      OR ("state" <> 'active' AND "terminalAt" IS NOT NULL))
  );

ALTER TABLE "ChatUnifiedOptimizerCostRun" ADD CONSTRAINT
  "ChatUnifiedOptimizerCostRun_closed_check" CHECK (
    "ordinal" BETWEEN 1 AND 3
    AND "quoteDigest" ~ '^[0-9a-f]{64}$'
    AND "questionCount" > 0
    AND "quotedMicroUsd" BETWEEN 0 AND 25000000
    AND "state" IN ('planned', 'active', 'succeeded', 'stopped_unknown',
      'stopped_overrun', 'stopped_late')
    AND (("state" = 'planned' AND "startedAt" IS NULL AND "terminalAt" IS NULL)
      OR ("state" = 'active' AND "startedAt" IS NOT NULL AND "terminalAt" IS NULL)
      OR ("state" NOT IN ('planned', 'active')
        AND "startedAt" IS NOT NULL AND "terminalAt" IS NOT NULL))
  );

ALTER TABLE "ChatUnifiedOptimizerQuotaContract" ADD CONSTRAINT
  "ChatUnifiedOptimizerQuotaContract_closed_check" CHECK (
    "bindingDigest" ~ '^[0-9a-f]{64}$'
    AND "quotaContractDigest" ~ '^[0-9a-f]{64}$'
    AND "role" IN ('candidate_author', 'case_author', 'case_reviewer',
      'judge_primary', 'judge_secondary', 'coordinator')
    AND "billingMode" IN ('api', 'subscription_cli')
    AND "vendorId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND "adapterId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND position('..' in "vendorId") = 0 AND position('..' in "adapterId") = 0
    AND "measurementState" IN ('s0_probe_authorized', 'before_after_verified')
    AND "afterReadbackRequired"
    AND "callsPerRunCap" > 0
    AND ("inputTokensPerRunCap" IS NULL OR "inputTokensPerRunCap" > 0)
    AND ("outputTokensPerRunCap" IS NULL OR "outputTokensPerRunCap" > 0)
    AND "provenanceDigest" ~ '^[0-9a-f]{64}$'
    AND "provenanceObservedAt" < "provenanceExpiresAt"
  );

ALTER TABLE "ChatUnifiedOptimizerCostCall" ADD CONSTRAINT
  "ChatUnifiedOptimizerCostCall_closed_check" CHECK (
    "role" IN ('candidate_author', 'case_author', 'case_reviewer',
      'judge_primary', 'judge_secondary', 'coordinator')
    AND "billingMode" IN ('api', 'subscription_cli')
    AND "costMeaning" IN ('api_reservation_ceiling', 'cli_api_conversion_estimate')
    AND "vendorId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND "adapterId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    AND position('..' in "vendorId") = 0 AND position('..' in "adapterId") = 0
    AND "bindingDigest" ~ '^[0-9a-f]{64}$'
    AND "priceSetDigest" ~ '^[0-9a-f]{64}$'
    AND "priceQuoteDigest" ~ '^[0-9a-f]{64}$'
    AND "priceVerifiedAt" < "priceExpiresAt"
    AND "calls" > 0
    AND "inputTokensCapPerCall" >= 0 AND "outputTokensCapPerCall" >= 0
    AND "worstCaseMicroUsdPerCall" >= 0
  );

ALTER TABLE "ChatUnifiedOptimizerCostWindow" ADD CONSTRAINT
  "ChatUnifiedOptimizerCostWindow_closed_check" CHECK (
    "period" IN ('day', 'month')
    AND "committedMicroUsd" >= 0 AND "revision" >= 0
  );

ALTER TABLE "ChatUnifiedOptimizerDispatchHold" ADD CONSTRAINT
  "ChatUnifiedOptimizerDispatchHold_closed_check" CHECK (
    "invocationOrdinal" > 0
    AND "reservationRequestDigest" ~ '^[0-9a-f]{64}$'
    AND "reservedMicroUsd" >= 0
    AND ("settledMicroUsd" IS NULL OR "settledMicroUsd" >= 0)
    AND ("settledInputTokens" IS NULL OR "settledInputTokens" >= 0)
    AND ("settledOutputTokens" IS NULL OR "settledOutputTokens" >= 0)
    AND "inputTokensCap" >= 0 AND "outputTokensCap" >= 0
    AND "preQuotaObservationDigest" ~ '^[0-9a-f]{64}$'
    AND "preQuotaObservedAt" < "preQuotaExpiresAt"
    AND "preQuotaCallsRemaining" >= 0
    AND ("preQuotaInputTokensRemaining" IS NULL OR "preQuotaInputTokensRemaining" >= 0)
    AND ("preQuotaOutputTokensRemaining" IS NULL OR "preQuotaOutputTokensRemaining" >= 0)
    AND "state" IN ('dispatch_intended', 'settled', 'outcome_unknown',
      'quota_outcome_unknown')
    AND NOT "externalDispatchAuthorized"
    AND (("state" = 'dispatch_intended'
      AND "settledMicroUsd" IS NULL AND "terminalRequestId" IS NULL
      AND "settledInputTokens" IS NULL AND "settledOutputTokens" IS NULL
      AND "terminalRequestDigest" IS NULL AND "terminalObservationDigest" IS NULL
      AND "afterQuotaObservedAt" IS NULL AND "afterQuotaExpiresAt" IS NULL
      AND "afterQuotaCallsRemaining" IS NULL
      AND "afterQuotaInputTokensRemaining" IS NULL
      AND "afterQuotaOutputTokensRemaining" IS NULL
      AND "terminalAuditLogId" IS NULL AND "terminalAt" IS NULL)
    OR ("state" = 'outcome_unknown'
      AND "settledMicroUsd" IS NULL AND "terminalRequestId" IS NOT NULL
      AND "settledInputTokens" IS NULL AND "settledOutputTokens" IS NULL
      AND "terminalRequestDigest" ~ '^[0-9a-f]{64}$'
      AND "terminalObservationDigest" ~ '^[0-9a-f]{64}$'
      AND "afterQuotaObservedAt" IS NULL AND "afterQuotaExpiresAt" IS NULL
      AND "afterQuotaCallsRemaining" IS NULL
      AND "afterQuotaInputTokensRemaining" IS NULL
      AND "afterQuotaOutputTokensRemaining" IS NULL
      AND "terminalAuditLogId" IS NOT NULL AND "terminalAt" IS NOT NULL)
    OR ("state" IN ('settled', 'quota_outcome_unknown')
      AND "settledMicroUsd" IS NOT NULL AND "terminalRequestId" IS NOT NULL
      AND "settledInputTokens" IS NOT NULL AND "settledOutputTokens" IS NOT NULL
      AND "terminalRequestDigest" ~ '^[0-9a-f]{64}$'
      AND "terminalObservationDigest" ~ '^[0-9a-f]{64}$'
      AND (("state" = 'settled'
        AND "afterQuotaObservedAt" IS NOT NULL AND "afterQuotaExpiresAt" IS NOT NULL
        AND "afterQuotaCallsRemaining" IS NOT NULL)
      OR ("state" = 'quota_outcome_unknown'
        AND "afterQuotaObservedAt" IS NULL AND "afterQuotaExpiresAt" IS NULL
        AND "afterQuotaCallsRemaining" IS NULL
        AND "afterQuotaInputTokensRemaining" IS NULL
        AND "afterQuotaOutputTokensRemaining" IS NULL))
      AND "terminalAuditLogId" IS NOT NULL AND "terminalAt" IS NOT NULL))
  );

CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostPlan_one_active_idx"
  ON "ChatUnifiedOptimizerCostPlan"((1)) WHERE "state" = 'active';
CREATE UNIQUE INDEX "ChatUnifiedOptimizerCostRun_one_active_idx"
  ON "ChatUnifiedOptimizerCostRun"((1)) WHERE "state" = 'active';

CREATE FUNCTION "chat_unified_optimizer_cost_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat_unified_optimizer_cost_immutable' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerQuotaContract_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerQuotaContract"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerQuotaContract_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerQuotaContract"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCostCall_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerCostCall"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCostCall_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCostCall"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();

CREATE FUNCTION "chat_unified_optimizer_cost_plan_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE registration_audit "AdminAuditLog"%ROWTYPE;
DECLARE activation_audit "AdminAuditLog"%ROWTYPE;
DECLARE cycle_row "ChatUnifiedOptimizerCycle"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    SELECT * INTO registration_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."registrationAuditLogId"
        AND xmin = pg_current_xact_id()::xid;
    SELECT * INTO activation_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."activationAuditLogId";
    SELECT * INTO cycle_row FROM "ChatUnifiedOptimizerCycle"
      WHERE "id" = NEW."cycleId";
    IF NEW."state" <> 'active' OR NEW."terminalAt" IS NOT NULL
      OR cycle_row."state" <> 'succeeded'
      OR cycle_row."externalDispatchAuthorized" OR cycle_row."paidAuthorized"
      OR registration_audit."id" IS NULL
      OR registration_audit."action" <> 'chat.unified_optimizer.cost_plan_registered'
      OR registration_audit."targetType" <> 'ChatUnifiedOptimizerCostPlan'
      OR registration_audit."targetId" <> NEW."id"::text
      OR registration_audit."actorUserId" IS NOT NULL
      OR registration_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR registration_audit."metadata"->>'registrationDigest' <> NEW."registrationDigest"
      OR registration_audit."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR activation_audit."id" IS NULL
      OR activation_audit."action" <> 'chat.unified_optimizer.paid_scope_activated'
      OR activation_audit."targetType" <> 'AppSetting'
      OR activation_audit."targetId" <> 'chat.unified_optimizer.paid_scope_activation'
      OR activation_audit."actorUserId" IS NULL
      OR activation_audit."metadata" ? 'systemActor'
      OR activation_audit."metadata"->>'activationDigest' <> NEW."activationDigest" THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_insert_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" <> 'active'
    OR NEW."state" NOT IN ('succeeded', 'stopped_unknown', 'stopped_overrun', 'stopped_late')
    OR NEW."terminalAt" IS NULL
    OR (NEW."id", NEW."cycleId", NEW."requestId", NEW."registrationDigest",
        NEW."planDigest", NEW."policyVersion", NEW."purpose",
        NEW."sourceApprovalTarget", NEW."baseSha", NEW."priceSetDigest",
        NEW."wholePlanQuotedMicroUsd", NEW."activationDigest",
        NEW."activationAuditLogId", NEW."registrationAuditLogId",
        NEW."externalDispatchAuthorized", NEW."createdAt") IS DISTINCT FROM
       (OLD."id", OLD."cycleId", OLD."requestId", OLD."registrationDigest",
        OLD."planDigest", OLD."policyVersion", OLD."purpose",
        OLD."sourceApprovalTarget", OLD."baseSha", OLD."priceSetDigest",
        OLD."wholePlanQuotedMicroUsd", OLD."activationDigest",
        OLD."activationAuditLogId", OLD."registrationAuditLogId",
        OLD."externalDispatchAuthorized", OLD."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_transition_invalid' USING ERRCODE = 'P0001';
  END IF;
  NEW."terminalAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerCostPlan_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerCostPlan"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCostPlan_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCostPlan"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();

CREATE FUNCTION "chat_unified_optimizer_cost_run_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_run_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    IF NEW."state" <> 'planned' OR NEW."startedAt" IS NOT NULL
      OR NEW."terminalAt" IS NOT NULL THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_run_insert_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."planId", NEW."optimizerRunId", NEW."ordinal",
      NEW."quoteDigest", NEW."corpusSlotId", NEW."questionCount",
      NEW."quotedMicroUsd", NEW."createdAt") IS DISTINCT FROM
     (OLD."id", OLD."planId", OLD."optimizerRunId", OLD."ordinal",
      OLD."quoteDigest", OLD."corpusSlotId", OLD."questionCount",
      OLD."quotedMicroUsd", OLD."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_run_identity_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."state" = 'planned' AND NEW."state" = 'active'
    AND NEW."terminalAt" IS NULL THEN
    NEW."startedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."state" = 'active'
    AND NEW."state" IN ('succeeded', 'stopped_unknown', 'stopped_overrun', 'stopped_late')
    AND NEW."startedAt" IS NOT DISTINCT FROM OLD."startedAt" THEN
    NEW."terminalAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat_unified_optimizer_cost_run_transition_invalid' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerCostRun_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerCostRun"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_run_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCostRun_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCostRun"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();

CREATE FUNCTION "chat_unified_optimizer_quota_contract_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan_row "ChatUnifiedOptimizerCostPlan"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO plan_row FROM "ChatUnifiedOptimizerCostPlan" WHERE "id" = NEW."planId";
  IF plan_row."state" <> 'active'
    OR (plan_row."purpose" = 's0_probe'
      AND NEW."measurementState" <> 's0_probe_authorized')
    OR (plan_row."purpose" = 'normal_cycle'
      AND NEW."measurementState" <> 'before_after_verified') THEN
    RAISE EXCEPTION 'chat_unified_optimizer_quota_contract_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerQuotaContract_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerQuotaContract"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_quota_contract_guard"();

CREATE FUNCTION "chat_unified_optimizer_cost_call_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_row "ChatUnifiedOptimizerCostRun"%ROWTYPE;
DECLARE quota_row "ChatUnifiedOptimizerQuotaContract"%ROWTYPE;
DECLARE job_row "ChatUnifiedOptimizerRoleJob"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO run_row FROM "ChatUnifiedOptimizerCostRun" WHERE "id" = NEW."runId";
  SELECT * INTO quota_row FROM "ChatUnifiedOptimizerQuotaContract"
    WHERE "id" = NEW."quotaContractId";
  SELECT * INTO job_row FROM "ChatUnifiedOptimizerRoleJob"
    WHERE "id" = NEW."optimizerRoleJobId";
  IF run_row."id" IS NULL OR quota_row."id" IS NULL OR job_row."id" IS NULL
    OR run_row."planId" <> NEW."planId" OR quota_row."planId" <> NEW."planId"
    OR run_row."optimizerRunId" <> job_row."runId"
    OR (NEW."role", NEW."billingMode", NEW."vendorId", NEW."adapterId",
        NEW."modelId", NEW."bindingDigest") IS DISTINCT FROM
       (quota_row."role", quota_row."billingMode", quota_row."vendorId",
        quota_row."adapterId", quota_row."modelId", quota_row."bindingDigest")
    OR NEW."role" <> job_row."role"
    OR NEW."priceSetDigest" <> (SELECT "priceSetDigest"
      FROM "ChatUnifiedOptimizerCostPlan" WHERE "id" = NEW."planId")
    OR NEW."calls" > quota_row."callsPerRunCap"
    OR NEW."calls"::bigint * NEW."inputTokensCapPerCall" >
      COALESCE(quota_row."inputTokensPerRunCap"::bigint,
        NEW."calls"::bigint * NEW."inputTokensCapPerCall")
    OR NEW."calls"::bigint * NEW."outputTokensCapPerCall" >
      COALESCE(quota_row."outputTokensPerRunCap"::bigint,
        NEW."calls"::bigint * NEW."outputTokensCapPerCall") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_call_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerCostCall_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerCostCall"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_call_guard"();

CREATE FUNCTION "chat_unified_optimizer_cost_window_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_window_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."committedMicroUsd" <> 0 OR NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_window_insert_invalid' USING ERRCODE = 'P0001';
    END IF;
    NEW."updatedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW."period", NEW."periodStart") IS DISTINCT FROM
      (OLD."period", OLD."periodStart")
    OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_window_update_invalid' USING ERRCODE = 'P0001';
  END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerCostWindow_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerCostWindow"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_cost_window_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCostWindow_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCostWindow"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();

CREATE FUNCTION "chat_unified_optimizer_dispatch_hold_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE call_row "ChatUnifiedOptimizerCostCall"%ROWTYPE;
DECLARE run_row "ChatUnifiedOptimizerCostRun"%ROWTYPE;
DECLARE plan_row "ChatUnifiedOptimizerCostPlan"%ROWTYPE;
DECLARE reserve_audit "AdminAuditLog"%ROWTYPE;
DECLARE intent_audit "AdminAuditLog"%ROWTYPE;
DECLARE terminal_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_dispatch_hold_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    SELECT * INTO call_row FROM "ChatUnifiedOptimizerCostCall"
      WHERE "id" = NEW."callBucketId";
    SELECT * INTO run_row FROM "ChatUnifiedOptimizerCostRun" WHERE "id" = NEW."runId";
    SELECT * INTO plan_row FROM "ChatUnifiedOptimizerCostPlan" WHERE "id" = NEW."planId";
    SELECT * INTO reserve_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."reservationAuditLogId" AND xmin = pg_current_xact_id()::xid;
    SELECT * INTO intent_audit FROM "AdminAuditLog"
      WHERE "id" = NEW."intentAuditLogId" AND xmin = pg_current_xact_id()::xid;
    IF NEW."state" <> 'dispatch_intended'
      OR call_row."id" IS NULL OR run_row."id" IS NULL OR plan_row."id" IS NULL
      OR call_row."runId" <> NEW."runId" OR call_row."planId" <> NEW."planId"
      OR run_row."planId" <> NEW."planId" OR plan_row."state" <> 'active'
      OR run_row."state" <> 'active'
      OR NEW."invocationOrdinal" > call_row."calls"
      OR NEW."reservedMicroUsd" <> call_row."worstCaseMicroUsdPerCall"
      OR NEW."inputTokensCap" <> call_row."inputTokensCapPerCall"
      OR NEW."outputTokensCap" <> call_row."outputTokensCapPerCall"
      OR reserve_audit."id" IS NULL
      OR reserve_audit."action" <> 'chat.unified_optimizer.call_reserved'
      OR reserve_audit."targetType" <> 'ChatUnifiedOptimizerDispatchHold'
      OR reserve_audit."targetId" <> NEW."id"::text
      OR reserve_audit."actorUserId" IS NOT NULL
      OR reserve_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR reserve_audit."metadata"->>'reservationRequestDigest' <>
        NEW."reservationRequestDigest"
      OR reserve_audit."metadata"->>'externalDispatchAuthorized' <> 'false'
      OR intent_audit."id" IS NULL
      OR intent_audit."action" <> 'chat.unified_optimizer.call_dispatch_intended'
      OR intent_audit."targetType" <> 'ChatUnifiedOptimizerDispatchHold'
      OR intent_audit."targetId" <> NEW."id"::text
      OR intent_audit."actorUserId" IS NOT NULL
      OR intent_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
      OR intent_audit."metadata"->>'reservationRequestDigest' <>
        NEW."reservationRequestDigest"
      OR intent_audit."metadata"->>'externalDispatchAuthorized' <> 'false' THEN
      RAISE EXCEPTION 'chat_unified_optimizer_dispatch_hold_insert_invalid' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."planId", NEW."runId", NEW."callBucketId",
      NEW."invocationOrdinal", NEW."reservationRequestId",
      NEW."reservationRequestDigest", NEW."intentId", NEW."reservedMicroUsd",
      NEW."inputTokensCap", NEW."outputTokensCap", NEW."dayStart",
      NEW."monthStart", NEW."preQuotaObservationDigest",
      NEW."preQuotaObservedAt", NEW."preQuotaExpiresAt",
      NEW."preQuotaCallsRemaining", NEW."preQuotaInputTokensRemaining",
      NEW."preQuotaOutputTokensRemaining", NEW."reservationAuditLogId",
      NEW."intentAuditLogId", NEW."externalDispatchAuthorized", NEW."createdAt")
    IS DISTINCT FROM
     (OLD."id", OLD."planId", OLD."runId", OLD."callBucketId",
      OLD."invocationOrdinal", OLD."reservationRequestId",
      OLD."reservationRequestDigest", OLD."intentId", OLD."reservedMicroUsd",
      OLD."inputTokensCap", OLD."outputTokensCap", OLD."dayStart",
      OLD."monthStart", OLD."preQuotaObservationDigest",
      OLD."preQuotaObservedAt", OLD."preQuotaExpiresAt",
      OLD."preQuotaCallsRemaining", OLD."preQuotaInputTokensRemaining",
      OLD."preQuotaOutputTokensRemaining", OLD."reservationAuditLogId",
      OLD."intentAuditLogId", OLD."externalDispatchAuthorized", OLD."createdAt")
    OR OLD."state" <> 'dispatch_intended'
    OR NEW."state" NOT IN ('settled', 'outcome_unknown', 'quota_outcome_unknown') THEN
    RAISE EXCEPTION 'chat_unified_optimizer_dispatch_hold_transition_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO terminal_audit FROM "AdminAuditLog"
    WHERE "id" = NEW."terminalAuditLogId" AND xmin = pg_current_xact_id()::xid;
  IF terminal_audit."id" IS NULL
    OR terminal_audit."action" <> (CASE
      WHEN NEW."state" = 'settled' THEN 'chat.unified_optimizer.call_settled'
      WHEN NEW."state" = 'quota_outcome_unknown'
        THEN 'chat.unified_optimizer.call_quota_outcome_unknown'
      ELSE 'chat.unified_optimizer.call_outcome_unknown' END)
    OR terminal_audit."targetType" <> 'ChatUnifiedOptimizerDispatchHold'
    OR terminal_audit."targetId" <> NEW."id"::text
    OR terminal_audit."actorUserId" IS NOT NULL
    OR terminal_audit."metadata"->>'systemActor' <> 'chat-unified-optimizer'
    OR terminal_audit."metadata"->>'terminalRequestDigest' <>
      NEW."terminalRequestDigest" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_dispatch_hold_terminal_invalid' USING ERRCODE = 'P0001';
  END IF;
  NEW."terminalAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerDispatchHold_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerDispatchHold"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_dispatch_hold_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerDispatchHold_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerDispatchHold"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_cost_immutable"();

-- Deferred aggregate checks make partial plans, skipped ordinals, direct
-- window manipulation and late success fail at COMMIT on PostgreSQL 17.
CREATE FUNCTION "chat_unified_optimizer_cost_plan_complete"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_plan UUID;
DECLARE plan_row "ChatUnifiedOptimizerCostPlan"%ROWTYPE;
DECLARE expected_runs INTEGER;
DECLARE run_count INTEGER;
DECLARE quote_total BIGINT;
DECLARE invalid_runs INTEGER;
DECLARE invalid_calls INTEGER;
DECLARE invalid_sequences INTEGER;
DECLARE succeeded_runs INTEGER;
DECLARE stopped_unknown_runs INTEGER;
DECLARE stopped_overrun_runs INTEGER;
DECLARE stopped_late_runs INTEGER;
DECLARE active_or_planned_runs INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCostPlan' THEN
    target_plan := NEW."id";
  ELSIF TG_TABLE_NAME IN ('ChatUnifiedOptimizerCostRun',
      'ChatUnifiedOptimizerQuotaContract', 'ChatUnifiedOptimizerCostCall',
      'ChatUnifiedOptimizerDispatchHold') THEN
    target_plan := NEW."planId";
  ELSE
    RETURN NULL;
  END IF;
  SELECT * INTO plan_row FROM "ChatUnifiedOptimizerCostPlan" WHERE "id" = target_plan;
  IF plan_row."id" IS NULL THEN RETURN NULL; END IF;
  expected_runs := CASE WHEN plan_row."purpose" = 'normal_cycle' THEN 3 ELSE 1 END;
  SELECT COUNT(*), COALESCE(SUM("quotedMicroUsd"), 0),
    COUNT(*) FILTER (WHERE
      (plan_row."purpose" = 'normal_cycle' AND "questionCount" < 80)
      OR (plan_row."purpose" = 's0_probe' AND "ordinal" <> 1)),
    COUNT(*) FILTER (WHERE "state" = 'succeeded'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_unknown'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_overrun'),
    COUNT(*) FILTER (WHERE "state" = 'stopped_late'),
    COUNT(*) FILTER (WHERE "state" IN ('active', 'planned'))
  INTO run_count, quote_total, invalid_runs, succeeded_runs,
    stopped_unknown_runs, stopped_overrun_runs, stopped_late_runs,
    active_or_planned_runs
  FROM "ChatUnifiedOptimizerCostRun" WHERE "planId" = target_plan;
  SELECT COUNT(*) INTO invalid_calls FROM "ChatUnifiedOptimizerCostRun" r
  WHERE r."planId" = target_plan AND (
    r."quotedMicroUsd" <> COALESCE((SELECT SUM(c."calls"::bigint *
      c."worstCaseMicroUsdPerCall") FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."runId" = r."id"), -1)
    OR NOT EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."runId" = r."id"));
  SELECT COUNT(*) INTO invalid_sequences FROM "ChatUnifiedOptimizerCostCall" c
  WHERE c."planId" = target_plan AND EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
    WHERE h."callBucketId" = c."id"
    HAVING COUNT(*) <> MAX(h."invocationOrdinal")
      OR MIN(h."invocationOrdinal") <> 1
      OR MAX(h."invocationOrdinal") > c."calls");
  IF run_count <> expected_runs OR quote_total <> plan_row."wholePlanQuotedMicroUsd"
    OR invalid_runs <> 0 OR invalid_calls <> 0 OR invalid_sequences <> 0
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerQuotaContract" q
      WHERE q."planId" = target_plan AND NOT EXISTS (
        SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
        WHERE c."quotaContractId" = q."id"))
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCostCall" c
      WHERE c."planId" = target_plan AND c."priceExpiresAt" <= plan_row."createdAt") THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF plan_row."state" = 'active' THEN
    IF stopped_unknown_runs + stopped_overrun_runs + stopped_late_runs <> 0 THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_state_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'succeeded' THEN
    IF succeeded_runs <> expected_runs OR EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerCostRun" cr
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
      WHERE cr."planId" = target_plan AND clock_timestamp() >= r."deadlineAt") THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_late_success' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_unknown' THEN
    IF stopped_unknown_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold"
      WHERE "planId" = target_plan
        AND "state" IN ('outcome_unknown', 'quota_outcome_unknown')) THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_unknown_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_overrun' THEN
    IF stopped_overrun_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold"
      WHERE "planId" = target_plan AND "state" = 'settled'
        AND "settledMicroUsd" > "reservedMicroUsd") THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_overrun_invalid' USING ERRCODE = 'P0001';
    END IF;
  ELSIF plan_row."state" = 'stopped_late' THEN
    IF stopped_late_runs = 0 OR NOT EXISTS (
      SELECT 1 FROM "ChatUnifiedOptimizerCostRun" cr
      JOIN "ChatUnifiedOptimizerRun" r ON r."id" = cr."optimizerRunId"
      WHERE cr."planId" = target_plan AND clock_timestamp() >= r."deadlineAt") THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_plan_late_invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerCostRun" r WHERE r."planId" = target_plan
      AND ((r."state" = 'planned' AND EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h WHERE h."runId" = r."id"))
        OR (r."state" = 'active' AND (
          NOT EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id")
          OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id"
              AND h."state" IN ('outcome_unknown', 'quota_outcome_unknown'))
          OR (SELECT COUNT(*) FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id" AND h."state" = 'settled') =
             (SELECT COALESCE(SUM(c."calls"), 0)
              FROM "ChatUnifiedOptimizerCostCall" c WHERE c."runId" = r."id")))
        OR (r."state" = 'succeeded' AND (
          (SELECT COUNT(*) FROM "ChatUnifiedOptimizerDispatchHold" h
            WHERE h."runId" = r."id" AND h."state" = 'settled') <>
          (SELECT COALESCE(SUM(c."calls"), 0) FROM "ChatUnifiedOptimizerCostCall" c
            WHERE c."runId" = r."id")))
        OR (r."state" = 'stopped_unknown' AND NOT EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
          WHERE h."runId" = r."id"
            AND h."state" IN ('outcome_unknown', 'quota_outcome_unknown')))
        OR (r."state" = 'stopped_overrun' AND NOT EXISTS (
          SELECT 1 FROM "ChatUnifiedOptimizerDispatchHold" h
          WHERE h."runId" = r."id" AND h."state" = 'settled'
            AND h."settledMicroUsd" > h."reservedMicroUsd")))) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_run_state_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "chat_unified_optimizer_cost_window_complete"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_period TEXT;
DECLARE target_start TIMESTAMPTZ;
DECLARE stored BIGINT;
DECLARE expected BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCostWindow' THEN
    target_period := NEW."period";
    target_start := NEW."periodStart";
  ELSE
    target_period := 'day';
    target_start := NEW."dayStart";
  END IF;
  SELECT "committedMicroUsd" INTO stored FROM "ChatUnifiedOptimizerCostWindow"
    WHERE "period" = target_period AND "periodStart" = target_start;
  SELECT COALESCE(SUM(CASE WHEN "state" IN ('settled', 'quota_outcome_unknown')
    THEN "settledMicroUsd"
    ELSE "reservedMicroUsd" END), 0) INTO expected
    FROM "ChatUnifiedOptimizerDispatchHold"
    WHERE (target_period = 'day' AND "dayStart" = target_start)
       OR (target_period = 'month' AND "monthStart" = target_start);
  IF stored IS NULL OR stored <> expected THEN
    RAISE EXCEPTION 'chat_unified_optimizer_cost_window_inconsistent' USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerDispatchHold' THEN
    target_period := 'month';
    target_start := NEW."monthStart";
    SELECT "committedMicroUsd" INTO stored FROM "ChatUnifiedOptimizerCostWindow"
      WHERE "period" = target_period AND "periodStart" = target_start;
    SELECT COALESCE(SUM(CASE WHEN "state" IN ('settled', 'quota_outcome_unknown')
      THEN "settledMicroUsd"
      ELSE "reservedMicroUsd" END), 0) INTO expected
      FROM "ChatUnifiedOptimizerDispatchHold" WHERE "monthStart" = target_start;
    IF stored IS NULL OR stored <> expected THEN
      RAISE EXCEPTION 'chat_unified_optimizer_cost_window_inconsistent' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCostPlan_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerCostPlan"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCostRun_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerCostRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerQuotaContract_complete"
AFTER INSERT ON "ChatUnifiedOptimizerQuotaContract"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCostCall_complete"
AFTER INSERT ON "ChatUnifiedOptimizerCostCall"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerDispatchHold_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerDispatchHold"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_plan_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCostWindow_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerCostWindow"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_window_complete"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerDispatchHold_window_complete"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerDispatchHold"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_cost_window_complete"();
