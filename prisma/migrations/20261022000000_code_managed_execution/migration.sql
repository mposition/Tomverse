-- Default-off Code managed inference. Financial metadata only; no prompts,
-- generated source, output JSON, paths, cookies or provider credentials.
CREATE TABLE "CodeTaskReservation" (
  "id" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "subjectKey" TEXT NOT NULL, "clientTaskId" TEXT NOT NULL, "requestDigest" TEXT NOT NULL,
  "productKey" TEXT NOT NULL DEFAULT 'code', "status" TEXT NOT NULL DEFAULT 'active',
  "catalogVersion" INTEGER NOT NULL, "contentHash" TEXT NOT NULL, "modelPair" JSONB NOT NULL,
  "reservedCredits" INTEGER NOT NULL, "settledCredits" INTEGER NOT NULL DEFAULT 0,
  "releasedCredits" INTEGER NOT NULL DEFAULT 0, "planHeldCredits" INTEGER NOT NULL, "planDayHeld" BOOLEAN NOT NULL,
  "addOnEntries" JSONB NOT NULL, "reservedCostMicroUsd" BIGINT NOT NULL,
  "settledCostMicroUsd" BIGINT NOT NULL DEFAULT 0, "heldCostMicroUsd" BIGINT NOT NULL,
  "planHeldCostMicroUsd" BIGINT NOT NULL, "planFundingShare" DOUBLE PRECISION NOT NULL,
  "dayStart" TIMESTAMPTZ NOT NULL, "monthStart" TIMESTAMPTZ NOT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("subjectKey","clientTaskId"),
  CHECK("productKey"='code'), CHECK("status" IN ('active','closed','interrupted')),
  CHECK("reservedCredits">0 AND "settledCredits">=0 AND "releasedCredits">=0 AND "settledCredits"+"releasedCredits"<="reservedCredits"),
  CHECK("planHeldCredits">=0 AND "reservedCostMicroUsd">=0 AND "settledCostMicroUsd">=0 AND "heldCostMicroUsd">=0 AND "planHeldCostMicroUsd">=0),
  CHECK("planFundingShare">=0 AND "planFundingShare"<=1)
);
CREATE INDEX "CodeTaskReservation_expiry" ON "CodeTaskReservation"("status","leaseExpiresAt");
CREATE INDEX "CodeTaskReservation_user" ON "CodeTaskReservation"("userId","createdAt");
CREATE TABLE "CodeManagedCall" (
  "id" TEXT PRIMARY KEY, "reservationId" TEXT NOT NULL REFERENCES "CodeTaskReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "productKey" TEXT NOT NULL DEFAULT 'code' CHECK("productKey"='code'),
  "requestDigest" TEXT NOT NULL, "role" TEXT NOT NULL, "modelId" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'dispatched', "reservedCredits" INTEGER NOT NULL, "settledCredits" INTEGER NOT NULL DEFAULT 0,
  "reservedCostMicroUsd" BIGINT NOT NULL, "settledCostMicroUsd" BIGINT,
  "inputTokens" INTEGER, "outputTokens" INTEGER, "cachedInputTokens" INTEGER, "cacheWriteInputTokens" INTEGER, "reasoningTokens" INTEGER,
  "maxOutputTokens" INTEGER NOT NULL, "pricingSnapshot" JSONB NOT NULL,
  "providerReportedModelId" TEXT, "latencyMs" INTEGER, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "completedAt" TIMESTAMPTZ,
  "resolutionId" TEXT UNIQUE, "resolutionDigest" TEXT, "resolutionAuditId" TEXT, "resolvedAt" TIMESTAMPTZ,
  CHECK("role" IN ('executor','reviewer')), CHECK("status" IN ('dispatched','completed','failed','outcome_unknown')),
  CHECK("reservedCredits">0 AND "settledCredits">=0 AND "settledCredits"<="reservedCredits" AND "reservedCostMicroUsd">=0),
  CHECK("inputTokens" IS NULL OR "inputTokens">=0), CHECK("outputTokens" IS NULL OR "outputTokens">=0),
  CHECK("cachedInputTokens" IS NULL OR ("cachedInputTokens">=0 AND "cachedInputTokens"<="inputTokens")),
  CHECK("cacheWriteInputTokens" IS NULL OR ("cacheWriteInputTokens">=0 AND "cacheWriteInputTokens"+COALESCE("cachedInputTokens",0)<="inputTokens")),
  CHECK("reasoningTokens" IS NULL OR ("reasoningTokens">=0 AND "reasoningTokens"<="outputTokens"))
);
CREATE INDEX "CodeManagedCall_task" ON "CodeManagedCall"("reservationId","createdAt");
CREATE INDEX "CodeManagedCall_active" ON "CodeManagedCall"("status","createdAt");
