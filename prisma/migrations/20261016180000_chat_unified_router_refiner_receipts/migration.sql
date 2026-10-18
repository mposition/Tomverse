-- Separate immutable, content-free receipts for the unified execution and its
-- final deterministic routing selection. The closed legacy receipt tables are
-- deliberately unchanged.
CREATE TABLE "ChatUnifiedExecutionReceipt" (
  "id" TEXT NOT NULL,
  "receiptVersion" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "resultId" TEXT,
  "stageVersion" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "adapterConfigDigest" TEXT NOT NULL,
  "pricePinDigest" TEXT NOT NULL,
  "provider" TEXT,
  "modelId" TEXT,
  "adapterVersion" TEXT,
  "outcome" TEXT NOT NULL,
  "failureCode" TEXT,
  "rewriteDecision" TEXT,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "dispatchedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "preparationLatencyMs" INTEGER NOT NULL,
  "inputTokens" BIGINT,
  "cachedInputTokens" BIGINT,
  "outputTokens" BIGINT,
  "reasoningTokens" BIGINT,
  "actualCostMicroUsd" BIGINT,
  "costStatus" TEXT NOT NULL,
  "retryCount" INTEGER NOT NULL,
  "auditLogId" TEXT NOT NULL,
  CONSTRAINT "ChatUnifiedExecutionReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedExecutionReceipt_closed_check" CHECK (
    "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "requestId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ("resultId" IS NULL OR "resultId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND "receiptVersion" = 'chat-unified-execution-v1'
    AND "stageVersion" = 'chat-unified-product-v1'
    AND "schemaVersion" = 'unified-router-refiner-v1'
    AND "promptVersion" = 'chat-unified-prompt-v1'
    AND "parserVersion" = 'parseChatUnifiedRouterRefinerOutput'
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND "adapterConfigDigest" ~ '^[0-9a-f]{64}$'
    AND "pricePinDigest" ~ '^[0-9a-f]{64}$'
    AND "outcome" IN ('analyzed', 'failed', 'refused_before_dispatch', 'unknown')
    AND ("failureCode" IS NULL OR "failureCode" IN (
      'unavailable_before_dispatch', 'budget_exhausted',
      'price_revalidation_failed', 'stale_or_late', 'timeout',
      'provider_error', 'invalid_response', 'execution_result_unknown',
      'persistence_result_unknown', 'unknown_after_dispatch'))
    AND ("rewriteDecision" IS NULL OR "rewriteDecision" IN ('keep_original', 'rewrite'))
    AND "retryCount" = 0
    AND "preparationLatencyMs" >= 0
    AND "completedAt" >= "requestedAt"
    AND "preparationLatencyMs" = ROUND(EXTRACT(EPOCH FROM ("completedAt" - "requestedAt")) * 1000)::INTEGER
    AND ("dispatchedAt" IS NULL OR
      ("dispatchedAt" >= "requestedAt" AND "dispatchedAt" <= "completedAt"))
    AND "costStatus" IN ('known', 'unknown', 'not_dispatched')
    AND ("provider" IS NULL) = ("modelId" IS NULL)
    AND ("provider" IS NULL) = ("adapterVersion" IS NULL)
    AND ("dispatchedAt" IS NULL OR "provider" IS NOT NULL)
    AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
    AND ("cachedInputTokens" IS NULL OR "cachedInputTokens" >= 0)
    AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
    AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
    AND ("actualCostMicroUsd" IS NULL OR "actualCostMicroUsd" >= 0)
    AND ("inputTokens" IS NULL OR "cachedInputTokens" IS NULL OR "cachedInputTokens" <= "inputTokens")
    AND ("outputTokens" IS NULL OR "reasoningTokens" IS NULL OR "reasoningTokens" <= "outputTokens")
    AND ("dispatchedAt" IS NOT NULL OR
      ("inputTokens" IS NULL AND "cachedInputTokens" IS NULL AND
       "outputTokens" IS NULL AND "reasoningTokens" IS NULL AND
       "actualCostMicroUsd" IS NULL))
    AND (("costStatus" = 'known' AND "dispatchedAt" IS NOT NULL AND "actualCostMicroUsd" IS NOT NULL)
      OR ("costStatus" = 'unknown' AND "actualCostMicroUsd" IS NULL)
      OR ("costStatus" = 'not_dispatched' AND "dispatchedAt" IS NULL AND "actualCostMicroUsd" IS NULL))
    AND (("outcome" = 'analyzed' AND "resultId" IS NOT NULL AND
          "failureCode" IS NULL AND "rewriteDecision" IS NOT NULL AND
          "dispatchedAt" IS NOT NULL AND "costStatus" = 'known')
      OR ("outcome" = 'failed' AND "resultId" IS NULL AND
          "failureCode" IN ('invalid_response', 'stale_or_late') AND
          "rewriteDecision" IS NULL AND "dispatchedAt" IS NOT NULL AND
          "costStatus" = 'known')
      OR ("outcome" = 'refused_before_dispatch' AND "resultId" IS NULL AND
          "failureCode" IN ('unavailable_before_dispatch', 'budget_exhausted',
            'price_revalidation_failed', 'stale_or_late', 'timeout') AND
          "rewriteDecision" IS NULL AND "dispatchedAt" IS NULL AND
          "costStatus" = 'not_dispatched')
      OR ("outcome" = 'unknown' AND "resultId" IS NULL AND
          "failureCode" IN ('timeout', 'provider_error', 'execution_result_unknown',
            'persistence_result_unknown', 'unknown_after_dispatch') AND
          "rewriteDecision" IS NULL AND "costStatus" <> 'not_dispatched'))
  )
);

CREATE UNIQUE INDEX "ChatUnifiedExecutionReceipt_requestId_key"
  ON "ChatUnifiedExecutionReceipt"("requestId");
CREATE UNIQUE INDEX "ChatUnifiedExecutionReceipt_resultId_key"
  ON "ChatUnifiedExecutionReceipt"("resultId");
CREATE UNIQUE INDEX "ChatUnifiedExecutionReceipt_auditLogId_key"
  ON "ChatUnifiedExecutionReceipt"("auditLogId");
CREATE INDEX "ChatUnifiedExecutionReceipt_outcome_completedAt_idx"
  ON "ChatUnifiedExecutionReceipt"("outcome", "completedAt");
CREATE INDEX "ChatUnifiedExecutionReceipt_completedAt_idx"
  ON "ChatUnifiedExecutionReceipt"("completedAt");

ALTER TABLE "ChatUnifiedExecutionReceipt"
  ADD CONSTRAINT "ChatUnifiedExecutionReceipt_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "ChatUnifiedRoutingReceipt" (
  "id" TEXT NOT NULL,
  "receiptVersion" TEXT NOT NULL,
  "executionReceiptId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "resultId" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "profileSource" TEXT,
  "taskKind" TEXT,
  "difficulty" TEXT,
  "taskProfileVersion" TEXT,
  "candidateFilterVersion" TEXT,
  "selectionVersion" TEXT,
  "scorePolicyVersion" TEXT,
  "evidenceRef" TEXT,
  "evidencePayloadDigest" TEXT,
  "selectedModelId" TEXT,
  "auditLogId" TEXT NOT NULL,
  CONSTRAINT "ChatUnifiedRoutingReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedRoutingReceipt_closed_check" CHECK (
    "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "receiptVersion" = 'chat-unified-routing-v1'
    AND "outcome" IN ('profile_only', 'rewrite_applied', 'stale')
    AND ("profileSource" IS NULL OR "profileSource" IN ('unified', 'deterministic'))
    AND ("taskKind" IS NULL OR "taskKind" IN ('coding', 'documents', 'research', 'writing', 'multilingual', 'general'))
    AND ("difficulty" IS NULL OR "difficulty" IN ('simple', 'standard', 'complex', 'unknown'))
    AND ("evidenceRef" IS NULL) = ("evidencePayloadDigest" IS NULL)
    AND ("evidencePayloadDigest" IS NULL OR "evidencePayloadDigest" ~ '^[0-9a-f]{64}$')
    AND (("outcome" = 'stale' AND "profileSource" IS NULL AND "taskKind" IS NULL
          AND "difficulty" IS NULL AND "taskProfileVersion" IS NULL
          AND "candidateFilterVersion" IS NULL AND "selectionVersion" IS NULL
          AND "scorePolicyVersion" IS NULL AND "evidenceRef" IS NULL
          AND "evidencePayloadDigest" IS NULL AND "selectedModelId" IS NULL)
      OR ("outcome" IN ('profile_only', 'rewrite_applied')
          AND "profileSource" IS NOT NULL AND "taskKind" IS NOT NULL
          AND "difficulty" IS NOT NULL AND "taskProfileVersion" IS NOT NULL
          AND "candidateFilterVersion" IS NOT NULL AND "selectionVersion" IS NOT NULL
          AND "scorePolicyVersion" IS NOT NULL AND "selectedModelId" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "ChatUnifiedRoutingReceipt_executionReceiptId_key"
  ON "ChatUnifiedRoutingReceipt"("executionReceiptId");
CREATE UNIQUE INDEX "ChatUnifiedRoutingReceipt_requestId_key"
  ON "ChatUnifiedRoutingReceipt"("requestId");
CREATE UNIQUE INDEX "ChatUnifiedRoutingReceipt_resultId_key"
  ON "ChatUnifiedRoutingReceipt"("resultId");
CREATE UNIQUE INDEX "ChatUnifiedRoutingReceipt_auditLogId_key"
  ON "ChatUnifiedRoutingReceipt"("auditLogId");
CREATE INDEX "ChatUnifiedRoutingReceipt_outcome_observedAt_idx"
  ON "ChatUnifiedRoutingReceipt"("outcome", "observedAt");
CREATE INDEX "ChatUnifiedRoutingReceipt_observedAt_idx"
  ON "ChatUnifiedRoutingReceipt"("observedAt");

ALTER TABLE "ChatUnifiedRoutingReceipt"
  ADD CONSTRAINT "ChatUnifiedRoutingReceipt_executionReceiptId_fkey"
  FOREIGN KEY ("executionReceiptId") REFERENCES "ChatUnifiedExecutionReceipt"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedRoutingReceipt"
  ADD CONSTRAINT "ChatUnifiedRoutingReceipt_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- U11 originally described consumption as an attempt transition even though
-- the attempt deliberately remains held as the durable one-shot authority.
-- Bind the audit to the result row whose state actually changes.
CREATE OR REPLACE FUNCTION "guard_chat_unified_router_refiner_consume"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  audit_row "AdminAuditLog";
  conversation_mode TEXT;
  conversation_mode_epoch INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c."selectionMode", c."chatUnifiedRouterRefinerModeEpoch"
      INTO conversation_mode, conversation_mode_epoch
      FROM "Conversation" c
      WHERE c."id" = NEW."conversationId" AND c."userId" = NEW."userId"
      FOR SHARE;
    IF NEW."consumptionAuditLogId" IS NOT NULL
      OR NEW."modeEpoch" IS DISTINCT FROM conversation_mode_epoch
      OR conversation_mode IS DISTINCT FROM 'auto' THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_mode_binding_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."modeEpoch" IS DISTINCT FROM OLD."modeEpoch" THEN
    RAISE EXCEPTION 'chat_unified_router_refiner_mode_binding_invalid';
  END IF;
  IF NEW."state" = 'consumed' THEN
    IF OLD."consumptionAuditLogId" IS NOT NULL OR NEW."consumptionAuditLogId" IS NULL THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
    END IF;
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."consumptionAuditLogId" FOR SHARE;
    IF audit_row."id" IS NULL
      OR audit_row."action" IS DISTINCT FROM 'chat.unified_router_refiner_result_consumed'
      OR audit_row."targetType" IS DISTINCT FROM 'ChatUnifiedRouterRefinerResult'
      OR audit_row."targetId" IS DISTINCT FROM NEW."id"
      OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL
      OR audit_row."entryHash" IS NULL
      OR audit_row."metadata"->>'systemActor' IS DISTINCT FROM 'prompt-refiner-product-execution'
      OR audit_row."metadata"->>'authorityKind' IS DISTINCT FROM 'unified_router_refiner'
      OR audit_row."metadata"->>'state' IS DISTINCT FROM 'consumed' THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
    END IF;
  ELSIF NEW."consumptionAuditLogId" IS DISTINCT FROM OLD."consumptionAuditLogId" THEN
    RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "chat_unified_receipt_append_only"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat_unified_receipt_append_only' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "ChatUnifiedExecutionReceipt_append_only"
BEFORE UPDATE OR DELETE ON "ChatUnifiedExecutionReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_receipt_append_only"();
CREATE TRIGGER "ChatUnifiedExecutionReceipt_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedExecutionReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_receipt_append_only"();
CREATE TRIGGER "ChatUnifiedRoutingReceipt_append_only"
BEFORE UPDATE OR DELETE ON "ChatUnifiedRoutingReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_receipt_append_only"();
CREATE TRIGGER "ChatUnifiedRoutingReceipt_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedRoutingReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_receipt_append_only"();

CREATE FUNCTION "chat_unified_execution_receipt_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_row "PromptRefinerProductAttempt"%ROWTYPE;
  result_row "ChatUnifiedRouterRefinerResult"%ROWTYPE;
  audit_row "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM "PromptRefinerProductAttempt"
    WHERE "id" = NEW."requestId";
  SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."auditLogId";
  IF NOT FOUND OR attempt_row."id" IS NULL
    OR audit_row."id" IS NULL
    OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
    OR audit_row."action" <> 'chat.unified_router_refiner_receipt_recorded'
    OR audit_row."targetType" <> 'ChatUnifiedExecutionReceipt'
    OR audit_row."targetId" <> NEW."id"
    OR audit_row."metadata"->>'systemActor' <> 'prompt-refiner-product-execution'
    OR audit_row."metadata"->>'authorityKind' <> 'unified_router_refiner'
    OR audit_row."metadata"->>'receiptKind' <> 'execution'
    OR audit_row."metadata"->>'outcome' <> NEW."outcome"
    OR (NEW."outcome" = 'analyzed' AND attempt_row."state" <> 'held')
    OR (NEW."outcome" IN ('failed', 'refused_before_dispatch') AND attempt_row."state" <> 'terminal')
    OR (NEW."outcome" = 'unknown' AND attempt_row."state" <> 'unknown') THEN
    RAISE EXCEPTION 'chat_unified_execution_receipt_binding_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."outcome" = 'analyzed' THEN
    SELECT * INTO result_row FROM "ChatUnifiedRouterRefinerResult"
      WHERE "id" = NEW."resultId";
    IF NOT FOUND OR result_row."attemptId" <> NEW."requestId"
      OR result_row."state" <> 'ready'
      OR result_row."schemaVersion" <> NEW."schemaVersion"
      OR result_row."promptVersion" <> NEW."promptVersion"
      OR result_row."candidateDigest" <> NEW."candidateDigest"
      OR result_row."adapterConfigDigest" <> NEW."adapterConfigDigest"
      OR result_row."pricePinDigest" <> NEW."pricePinDigest"
      OR result_row."rewriteDecision" <> NEW."rewriteDecision" THEN
      RAISE EXCEPTION 'chat_unified_execution_receipt_result_invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedExecutionReceipt_guard"
BEFORE INSERT ON "ChatUnifiedExecutionReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_execution_receipt_guard"();

CREATE FUNCTION "chat_unified_routing_receipt_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  execution_row "ChatUnifiedExecutionReceipt"%ROWTYPE;
  result_row "ChatUnifiedRouterRefinerResult"%ROWTYPE;
  audit_row "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO execution_row FROM "ChatUnifiedExecutionReceipt"
    WHERE "id" = NEW."executionReceiptId";
  SELECT * INTO result_row FROM "ChatUnifiedRouterRefinerResult"
    WHERE "id" = NEW."resultId";
  SELECT * INTO audit_row FROM "AdminAuditLog" WHERE "id" = NEW."auditLogId";
  IF execution_row."id" IS NULL OR result_row."id" IS NULL OR audit_row."id" IS NULL
    OR execution_row."outcome" <> 'analyzed'
    OR execution_row."requestId" <> NEW."requestId"
    OR execution_row."resultId" <> NEW."resultId"
    OR result_row."attemptId" <> NEW."requestId"
    OR result_row."state" <> 'consumed' OR result_row."consumptionAuditLogId" IS NULL
    OR (NEW."outcome" = 'profile_only' AND result_row."rewriteDecision" <> 'keep_original')
    OR (NEW."outcome" = 'rewrite_applied' AND result_row."rewriteDecision" <> 'rewrite')
    OR audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL
    OR audit_row."action" <> 'chat.unified_router_refiner_receipt_recorded'
    OR audit_row."targetType" <> 'ChatUnifiedRoutingReceipt'
    OR audit_row."targetId" <> NEW."id"
    OR audit_row."metadata"->>'systemActor' <> 'prompt-refiner-product-execution'
    OR audit_row."metadata"->>'authorityKind' <> 'unified_router_refiner'
    OR audit_row."metadata"->>'receiptKind' <> 'routing'
    OR audit_row."metadata"->>'outcome' <> NEW."outcome" THEN
    RAISE EXCEPTION 'chat_unified_routing_receipt_binding_invalid' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedRoutingReceipt_guard"
BEFORE INSERT ON "ChatUnifiedRoutingReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_routing_receipt_guard"();
