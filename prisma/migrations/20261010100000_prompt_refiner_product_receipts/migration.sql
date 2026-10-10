-- Private admission tombstones contain ownership and scope binding but no
-- prompt, attachment or digest. A unique draft epoch can authorize at most one
-- product attempt, even when the same HTTP body is sent concurrently.
CREATE TABLE "PromptRefinerProductAttempt" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "scopeId" TEXT NOT NULL REFERENCES "PromptRefinerChatScope"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "scopeEpoch" INTEGER NOT NULL CHECK ("scopeEpoch" > 0),
  "draftId" TEXT NOT NULL,
  "draftRevision" INTEGER NOT NULL CHECK ("draftRevision" > 0),
  "mode" TEXT NOT NULL CHECK ("mode" IN ('explicit', 'auto')),
  "clientRequestId" TEXT NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('preparing', 'held', 'terminal', 'unknown')),
  "suggestionId" TEXT REFERENCES "PromptRefinerChatSuggestion"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "sourceMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("userId", "scopeId", "scopeEpoch", "draftId", "draftRevision", "mode"),
  UNIQUE ("clientRequestId"),
  CHECK ("expiresAt" > "createdAt"),
  CHECK (("state" = 'held' AND "suggestionId" IS NOT NULL)
    OR ("state" <> 'held' AND "suggestionId" IS NULL))
);
CREATE INDEX "PromptRefinerProductAttempt_scopeId_state_idx"
  ON "PromptRefinerProductAttempt" ("scopeId", "state");
CREATE INDEX "PromptRefinerProductAttempt_expiresAt_state_idx"
  ON "PromptRefinerProductAttempt" ("expiresAt", "state");

CREATE FUNCTION "guard_prompt_refiner_product_attempt"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE scope_row "PromptRefinerChatScope"; draft_row "ChatComposerDraft";
  suggestion_row "PromptRefinerChatSuggestion";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'preparing' OR NEW."suggestionId" IS NOT NULL
      OR NEW."sourceMessageId" IS NOT NULL THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_initial_state_invalid';
    END IF;
    SELECT * INTO scope_row FROM "PromptRefinerChatScope"
      WHERE "id" = NEW."scopeId" FOR UPDATE;
    SELECT * INTO draft_row FROM "ChatComposerDraft"
      WHERE "id" = NEW."draftId" FOR SHARE;
    IF scope_row."id" IS NULL OR draft_row."id" IS NULL
      OR scope_row."userId" IS DISTINCT FROM NEW."userId"
      OR scope_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR scope_row."epoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR scope_row."surface" IS DISTINCT FROM 'chat'
      OR draft_row."userId" IS DISTINCT FROM NEW."userId"
      OR draft_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR draft_row."revision" IS DISTINCT FROM NEW."draftRevision" THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_binding_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD."state" <> 'preparing'
    OR NEW."state" NOT IN ('held', 'terminal', 'unknown')
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
    OR NEW."scopeId" IS DISTINCT FROM OLD."scopeId"
    OR NEW."scopeEpoch" IS DISTINCT FROM OLD."scopeEpoch"
    OR NEW."draftId" IS DISTINCT FROM OLD."draftId"
    OR NEW."draftRevision" IS DISTINCT FROM OLD."draftRevision"
    OR NEW."mode" IS DISTINCT FROM OLD."mode"
    OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
    OR OLD."sourceMessageId" IS NOT NULL OR NEW."sourceMessageId" IS NOT NULL
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    -- A held attempt has one later mutation: the exact authored Message save
    -- binds its server-minted source id before deleting the draft.
    IF OLD."state" = 'held' AND NEW."state" = 'held'
      AND OLD."sourceMessageId" IS NULL AND NEW."sourceMessageId" IS NOT NULL
      AND NEW."suggestionId" IS NOT NULL
      AND NEW."id" IS NOT DISTINCT FROM OLD."id"
      AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
      AND NEW."conversationId" IS NOT DISTINCT FROM OLD."conversationId"
      AND NEW."scopeId" IS NOT DISTINCT FROM OLD."scopeId"
      AND NEW."scopeEpoch" IS NOT DISTINCT FROM OLD."scopeEpoch"
      AND NEW."draftId" IS NOT DISTINCT FROM OLD."draftId"
      AND NEW."draftRevision" IS NOT DISTINCT FROM OLD."draftRevision"
      AND NEW."mode" IS NOT DISTINCT FROM OLD."mode"
      AND NEW."clientRequestId" IS NOT DISTINCT FROM OLD."clientRequestId"
      AND NEW."suggestionId" IS NOT DISTINCT FROM OLD."suggestionId"
      AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
      AND NEW."expiresAt" IS NOT DISTINCT FROM OLD."expiresAt" THEN
      SELECT * INTO suggestion_row FROM "PromptRefinerChatSuggestion"
        WHERE "id" = NEW."suggestionId" FOR SHARE;
      IF suggestion_row."sourceMessageId" IS DISTINCT FROM NEW."sourceMessageId" THEN
        RAISE EXCEPTION 'prompt_refiner_product_attempt_source_binding_invalid';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'prompt_refiner_product_attempt_transition_invalid';
  END IF;
  IF NEW."state" = 'held' THEN
    SELECT * INTO suggestion_row FROM "PromptRefinerChatSuggestion"
      WHERE "id" = NEW."suggestionId" FOR SHARE;
    IF suggestion_row."id" IS NULL
      OR suggestion_row."requestId" IS DISTINCT FROM NEW."id"
      OR suggestion_row."userId" IS DISTINCT FROM NEW."userId"
      OR suggestion_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR suggestion_row."scopeId" IS DISTINCT FROM NEW."scopeId"
      OR suggestion_row."scopeEpoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR suggestion_row."draftId" IS DISTINCT FROM NEW."draftId"
      OR suggestion_row."draftRevision" IS DISTINCT FROM NEW."draftRevision"
      OR suggestion_row."mode" IS DISTINCT FROM NEW."mode"
      OR suggestion_row."state" IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_suggestion_invalid';
    END IF;
  ELSIF NEW."suggestionId" IS NOT NULL THEN
    RAISE EXCEPTION 'prompt_refiner_product_attempt_terminal_suggestion_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PromptRefinerProductAttempt_guard"
  BEFORE INSERT OR UPDATE ON "PromptRefinerProductAttempt"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_product_attempt"();

-- Content-free immutable product receipts. These tables contain no user,
-- conversation, session, attachment, prompt or prompt-digest column.
CREATE TABLE "PromptRefinerProductExecutionReceipt" (
  "id" TEXT PRIMARY KEY,
  "receiptVersion" TEXT NOT NULL CHECK ("receiptVersion" = 'prompt-refiner-execution-v1'),
  "requestId" TEXT NOT NULL UNIQUE,
  "suggestionId" TEXT UNIQUE,
  "refinerVersion" TEXT NOT NULL CHECK ("refinerVersion" ~ '^suggest-v[1-9][0-9]{0,3}$'),
  "provider" TEXT,
  "modelId" TEXT,
  "adapterVersion" TEXT,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('suggested', 'failed', 'refused_before_dispatch')),
  "failureLayer" TEXT NOT NULL CHECK ("failureLayer" IN ('none', 'admission', 'adapter', 'provider', 'response_validation')),
  "failureCode" TEXT CHECK ("failureCode" IN (
    'eligibility_refused', 'execution_not_approved', 'execution_contract_mismatch',
    'reservation_authority_unavailable', 'adapter_unavailable', 'invalid_response',
    'empty_response', 'no_change', 'provider_error', 'timeout', 'cancelled',
    'unknown_after_dispatch')),
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "dispatchedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "preparationLatencyMs" INTEGER NOT NULL CHECK ("preparationLatencyMs" >= 0),
  "inputTokens" BIGINT CHECK ("inputTokens" >= 0),
  "cachedInputTokens" BIGINT CHECK ("cachedInputTokens" >= 0),
  "outputTokens" BIGINT CHECK ("outputTokens" >= 0),
  "reasoningTokens" BIGINT CHECK ("reasoningTokens" >= 0),
  "actualCostMicroUsd" BIGINT CHECK ("actualCostMicroUsd" >= 0),
  "retryCount" INTEGER NOT NULL CHECK ("retryCount" = 0),
  CHECK ("completedAt" >= "requestedAt"),
  CHECK ("dispatchedAt" IS NULL OR
    ("dispatchedAt" >= "requestedAt" AND "dispatchedAt" <= "completedAt")),
  CHECK ("preparationLatencyMs" = ROUND(EXTRACT(EPOCH FROM
    ("completedAt" - "requestedAt")) * 1000)::INTEGER),
  CHECK (("provider" IS NULL AND "modelId" IS NULL AND "adapterVersion" IS NULL)
    OR ("provider" IS NOT NULL AND "modelId" IS NOT NULL AND "adapterVersion" IS NOT NULL)),
  CHECK (("outcome" = 'suggested' AND "suggestionId" IS NOT NULL
      AND "dispatchedAt" IS NOT NULL AND "provider" IS NOT NULL
      AND "failureLayer" = 'none' AND "failureCode" IS NULL)
    OR ("outcome" = 'failed' AND "suggestionId" IS NULL
      AND "dispatchedAt" IS NOT NULL AND "provider" IS NOT NULL
      AND "failureLayer" <> 'none' AND "failureLayer" <> 'admission'
      AND "failureCode" IS NOT NULL)
    OR ("outcome" = 'refused_before_dispatch' AND "suggestionId" IS NULL
      AND "dispatchedAt" IS NULL AND "provider" IS NULL
      AND "failureLayer" IN ('admission', 'adapter') AND "failureCode" IS NOT NULL)),
  CHECK ("dispatchedAt" IS NOT NULL OR ("inputTokens" IS NULL
    AND "cachedInputTokens" IS NULL AND "outputTokens" IS NULL
    AND "reasoningTokens" IS NULL AND "actualCostMicroUsd" IS NULL)),
  CHECK (("failureCode" IN ('eligibility_refused', 'execution_not_approved',
      'execution_contract_mismatch', 'reservation_authority_unavailable')
      AND "failureLayer" = 'admission' AND "dispatchedAt" IS NULL)
    OR ("failureCode" = 'adapter_unavailable' AND "failureLayer" = 'adapter'
      AND "dispatchedAt" IS NULL)
    OR ("failureCode" IN ('provider_error', 'timeout', 'unknown_after_dispatch')
      AND "failureLayer" = 'provider' AND "dispatchedAt" IS NOT NULL)
    OR ("failureCode" IN ('invalid_response', 'empty_response', 'no_change')
      AND "failureLayer" = 'response_validation' AND "dispatchedAt" IS NOT NULL)
    OR ("failureCode" = 'cancelled' AND
      (("dispatchedAt" IS NULL AND "failureLayer" = 'admission') OR
       ("dispatchedAt" IS NOT NULL AND "failureLayer" = 'provider')))
    OR ("failureCode" IS NULL AND "failureLayer" = 'none'))
);
CREATE INDEX "PromptRefinerProductExecutionReceipt_completedAt_idx"
  ON "PromptRefinerProductExecutionReceipt" ("completedAt");
CREATE INDEX "PromptRefinerProductExecutionReceipt_outcome_completedAt_idx"
  ON "PromptRefinerProductExecutionReceipt" ("outcome", "completedAt");

CREATE TABLE "PromptRefinerProductExecutionContext" (
  "executionReceiptId" TEXT PRIMARY KEY REFERENCES
    "PromptRefinerProductExecutionReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "mode" TEXT NOT NULL CHECK ("mode" IN ('explicit', 'auto'))
);

CREATE TABLE "PromptRefinerProductDispositionReceipt" (
  "id" TEXT PRIMARY KEY,
  "receiptVersion" TEXT NOT NULL CHECK ("receiptVersion" = 'prompt-refiner-disposition-v1'),
  "executionReceiptId" TEXT NOT NULL UNIQUE REFERENCES
    "PromptRefinerProductExecutionReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" TEXT NOT NULL UNIQUE,
  "suggestionId" TEXT UNIQUE,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('accepted', 'kept_original', 'stale')),
  "staleReason" TEXT CHECK ("staleReason" IN (
    'draft_changed_while_requesting', 'scope_changed_while_requesting',
    'request_superseded', 'submitted_before_ready', 'draft_changed_after_ready',
    'scope_changed_after_ready')),
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  CHECK (("outcome" = 'stale' AND "staleReason" IS NOT NULL)
    OR ("outcome" IN ('accepted', 'kept_original') AND "suggestionId" IS NOT NULL
      AND "staleReason" IS NULL)),
  CHECK (("outcome" = 'stale' AND "staleReason" IN (
      'draft_changed_while_requesting', 'scope_changed_while_requesting',
      'request_superseded', 'submitted_before_ready') AND "suggestionId" IS NULL)
    OR ("outcome" = 'stale' AND "staleReason" IN (
      'draft_changed_after_ready', 'scope_changed_after_ready') AND "suggestionId" IS NOT NULL)
    OR "outcome" IN ('accepted', 'kept_original'))
);
CREATE INDEX "PromptRefinerProductDispositionReceipt_observedAt_idx"
  ON "PromptRefinerProductDispositionReceipt" ("observedAt");
CREATE INDEX "PromptRefinerProductDispositionReceipt_outcome_observedAt_idx"
  ON "PromptRefinerProductDispositionReceipt" ("outcome", "observedAt");

CREATE FUNCTION "guard_prompt_refiner_product_execution_receipt"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'prompt_refiner_product_execution_receipt_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PromptRefinerProductExecutionReceipt_immutable"
  BEFORE UPDATE OR DELETE ON "PromptRefinerProductExecutionReceipt"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_product_execution_receipt"();

CREATE TRIGGER "PromptRefinerProductExecutionContext_immutable"
  BEFORE UPDATE OR DELETE ON "PromptRefinerProductExecutionContext"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_product_execution_receipt"();

CREATE FUNCTION "guard_prompt_refiner_product_disposition_receipt"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE execution_row "PromptRefinerProductExecutionReceipt";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'prompt_refiner_product_disposition_receipt_immutable';
  END IF;
  SELECT * INTO execution_row FROM "PromptRefinerProductExecutionReceipt"
    WHERE "id" = NEW."executionReceiptId" FOR SHARE;
  IF execution_row."id" IS NULL
    OR execution_row."requestId" IS DISTINCT FROM NEW."requestId"
    OR NEW."observedAt" < execution_row."requestedAt"
    OR (NEW."suggestionId" IS NOT NULL AND
      (execution_row."outcome" <> 'suggested' OR
       execution_row."suggestionId" IS DISTINCT FROM NEW."suggestionId"))
    OR (NEW."suggestionId" IS NULL AND NEW."staleReason" NOT IN (
      'draft_changed_while_requesting', 'scope_changed_while_requesting',
      'request_superseded', 'submitted_before_ready'))
    OR (NEW."suggestionId" IS NOT NULL AND
      NEW."observedAt" < execution_row."completedAt") THEN
    RAISE EXCEPTION 'prompt_refiner_product_disposition_binding_invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PromptRefinerProductDispositionReceipt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerProductDispositionReceipt"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_product_disposition_receipt"();

CREATE FUNCTION "reject_prompt_refiner_product_truncate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prompt_refiner_product_truncate_forbidden';
END $$;
CREATE TRIGGER "PromptRefinerProductExecutionReceipt_no_truncate"
  BEFORE TRUNCATE ON "PromptRefinerProductExecutionReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_prompt_refiner_product_truncate"();
CREATE TRIGGER "PromptRefinerProductExecutionContext_no_truncate"
  BEFORE TRUNCATE ON "PromptRefinerProductExecutionContext"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_prompt_refiner_product_truncate"();
CREATE TRIGGER "PromptRefinerProductDispositionReceipt_no_truncate"
  BEFORE TRUNCATE ON "PromptRefinerProductDispositionReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_prompt_refiner_product_truncate"();

