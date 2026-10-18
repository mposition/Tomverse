-- One private, ephemeral authority row for a settled unified preprocessing
-- result. No product route is wired by this migration. The existing product
-- attempt remains the only per-draft admission tombstone.
CREATE TABLE "ChatUnifiedRouterRefinerResult" (
  "id" TEXT PRIMARY KEY,
  "attemptId" TEXT NOT NULL UNIQUE REFERENCES
    "PromptRefinerProductAttempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "scopeEpoch" INTEGER NOT NULL CHECK ("scopeEpoch" > 0),
  "recoveryEpoch" INTEGER NOT NULL CHECK ("recoveryEpoch" >= 0),
  "draftId" TEXT NOT NULL,
  "draftRevision" INTEGER NOT NULL CHECK ("draftRevision" > 0),
  "sourceMessageId" TEXT NOT NULL,
  "sourcePrompt" TEXT,
  "schemaVersion" TEXT NOT NULL
    CHECK ("schemaVersion" = 'unified-router-refiner-v1'),
  "promptVersion" TEXT NOT NULL
    CHECK ("promptVersion" = 'chat-unified-prompt-v1'),
  "candidateDigest" TEXT NOT NULL
    CHECK ("candidateDigest" ~ '^[0-9a-f]{64}$'),
  "adapterConfigDigest" TEXT NOT NULL
    CHECK ("adapterConfigDigest" ~ '^[0-9a-f]{64}$'),
  "pricePinDigest" TEXT NOT NULL
    CHECK ("pricePinDigest" ~ '^[0-9a-f]{64}$'),
  "runtimeDeploymentId" TEXT NOT NULL
    CHECK ("runtimeDeploymentId" ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  "holdId" TEXT NOT NULL UNIQUE REFERENCES
    "PromptRefinerAutoBudgetHold"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "analysisKind" TEXT NOT NULL CHECK ("analysisKind" IN (
    'coding', 'documents', 'research', 'writing', 'multilingual', 'general')),
  "analysisDifficulty" TEXT NOT NULL CHECK ("analysisDifficulty" IN (
    'simple', 'standard', 'complex', 'unknown')),
  "expectedOutputLength" TEXT NOT NULL CHECK ("expectedOutputLength" IN (
    'short', 'medium', 'long')),
  "needsCurrentInformation" BOOLEAN NOT NULL,
  "rewriteDecision" TEXT NOT NULL CHECK ("rewriteDecision" IN (
    'keep_original', 'rewrite')),
  "rewritePrompt" TEXT,
  "state" TEXT NOT NULL CHECK ("state" IN ('ready', 'consumed', 'stale')),
  "publishDeadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT
    (clock_timestamp() AT TIME ZONE 'UTC'),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_identity_length_check" CHECK (
    char_length("id") BETWEEN 1 AND 64 AND
    char_length("attemptId") BETWEEN 1 AND 64 AND
    char_length("sourceMessageId") BETWEEN 1 AND 64 AND
    char_length("holdId") BETWEEN 1 AND 64),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_server_uuid_check" CHECK (
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    "attemptId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    "sourceMessageId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    "holdId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_body_length_check" CHECK (
    "sourcePrompt" IS NULL OR
      (octet_length("sourcePrompt") <= 32768 AND length("sourcePrompt") <= 16000)),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_rewrite_length_check" CHECK (
    "rewritePrompt" IS NULL OR
      (octet_length("rewritePrompt") <= 32768 AND length("rewritePrompt") <= 16000)),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_expiry_check" CHECK (
    "expiresAt" > "createdAt" AND
    "expiresAt" <= "createdAt" + INTERVAL '5 minutes'),
  CONSTRAINT "ChatUnifiedRouterRefinerResult_state_body_check" CHECK (
    ("state" = 'ready' AND "sourcePrompt" IS NOT NULL
      AND "consumedAt" IS NULL
      AND (("rewriteDecision" = 'keep_original' AND "rewritePrompt" IS NULL)
        OR ("rewriteDecision" = 'rewrite' AND "rewritePrompt" IS NOT NULL)))
    OR ("state" = 'consumed' AND "sourcePrompt" IS NULL
      AND "rewritePrompt" IS NULL AND "consumedAt" IS NOT NULL
      AND "consumedAt" < "expiresAt")
    OR ("state" = 'stale' AND "sourcePrompt" IS NULL
      AND "rewritePrompt" IS NULL AND "consumedAt" IS NULL))
);

CREATE INDEX "ChatUnifiedRouterRefinerResult_scopeId_state_idx"
  ON "ChatUnifiedRouterRefinerResult" ("scopeId", "state");
CREATE INDEX "ChatUnifiedRouterRefinerResult_draftId_state_idx"
  ON "ChatUnifiedRouterRefinerResult" ("draftId", "state");
CREATE INDEX "ChatUnifiedRouterRefinerResult_expiresAt_state_idx"
  ON "ChatUnifiedRouterRefinerResult" ("expiresAt", "state");

-- Keep the database calculation identical to lib/messageRequestIdentity.ts.
-- PostgreSQL 17 supplies sha256(bytea) in core, so this needs no extension.
CREATE FUNCTION "chat_unified_router_refiner_source_message_id"(
  conversation_id TEXT,
  client_request_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  raw_id BYTEA;
  value TEXT;
BEGIN
  raw_id := substring(sha256(
    convert_to('tomverse:conversation-message:v1', 'UTF8') ||
    decode('00', 'hex') || convert_to(conversation_id, 'UTF8') ||
    decode('00', 'hex') || convert_to(client_request_id, 'UTF8')
  ) FROM 1 FOR 16);
  raw_id := set_byte(raw_id, 6, (get_byte(raw_id, 6) & 15) | 128);
  raw_id := set_byte(raw_id, 8, (get_byte(raw_id, 8) & 63) | 128);
  value := encode(raw_id, 'hex');
  RETURN substring(value FROM 1 FOR 8) || '-' ||
    substring(value FROM 9 FOR 4) || '-' ||
    substring(value FROM 13 FOR 4) || '-' ||
    substring(value FROM 17 FOR 4) || '-' ||
    substring(value FROM 21 FOR 12);
END $$;

CREATE FUNCTION "guard_chat_unified_router_refiner_result"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  attempt_row "PromptRefinerProductAttempt";
  scope_row "PromptRefinerChatScope";
  draft_row "ChatComposerDraft";
  conversation_recovery_epoch INTEGER;
  hold_row "PromptRefinerAutoBudgetHold";
  db_now TIMESTAMP(3);
  db_now_tz TIMESTAMPTZ(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    db_now := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    db_now_tz := clock_timestamp()::TIMESTAMPTZ(3);
    SELECT * INTO attempt_row FROM "PromptRefinerProductAttempt"
      WHERE "id" = NEW."attemptId" FOR UPDATE;
    SELECT * INTO scope_row FROM "PromptRefinerChatScope"
      WHERE "id" = NEW."scopeId" FOR SHARE;
    SELECT * INTO draft_row FROM "ChatComposerDraft"
      WHERE "id" = NEW."draftId" FOR SHARE;
    SELECT c."chatRecoveryEpoch" INTO conversation_recovery_epoch
      FROM "Conversation" c
      WHERE c."id" = NEW."conversationId" AND c."userId" = NEW."userId"
        AND c."kind" = 'chat' AND c."productKey" = 'chat'
      FOR SHARE;
    SELECT * INTO hold_row FROM "PromptRefinerAutoBudgetHold"
      WHERE "id" = NEW."holdId" FOR SHARE;

    IF NEW."state" IS DISTINCT FROM 'ready'
      OR NEW."consumedAt" IS NOT NULL
      OR attempt_row."id" IS NULL
      OR attempt_row."state" IS DISTINCT FROM 'preparing'
      OR attempt_row."mode" IS DISTINCT FROM 'auto'
      OR attempt_row."userId" IS DISTINCT FROM NEW."userId"
      OR attempt_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR attempt_row."scopeId" IS DISTINCT FROM NEW."scopeId"
      OR attempt_row."scopeEpoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR attempt_row."draftId" IS DISTINCT FROM NEW."draftId"
      OR attempt_row."draftRevision" IS DISTINCT FROM NEW."draftRevision"
      OR NEW."sourceMessageId" IS DISTINCT FROM
        "chat_unified_router_refiner_source_message_id"(
          NEW."conversationId", attempt_row."clientRequestId")
      OR attempt_row."id" IS DISTINCT FROM hold_row."requestKey"
      OR attempt_row."expiresAt" <= db_now
      OR scope_row."id" IS NULL
      OR scope_row."userId" IS DISTINCT FROM NEW."userId"
      OR scope_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR scope_row."surface" IS DISTINCT FROM 'chat'
      OR scope_row."epoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR draft_row."id" IS NULL
      OR draft_row."userId" IS DISTINCT FROM NEW."userId"
      OR draft_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR draft_row."revision" IS DISTINCT FROM NEW."draftRevision"
      OR draft_row."text" IS DISTINCT FROM NEW."sourcePrompt"
      OR conversation_recovery_epoch IS DISTINCT FROM NEW."recoveryEpoch"
      OR hold_row."id" IS NULL
      OR hold_row."status" IS DISTINCT FROM 'settled'
      OR hold_row."candidateDigest" IS DISTINCT FROM NEW."candidateDigest"
      OR hold_row."pricePinDigest" IS DISTINCT FROM NEW."pricePinDigest"
      OR hold_row."runtimeDeploymentId" IS DISTINCT FROM NEW."runtimeDeploymentId"
      OR hold_row."adapterConfigDigest" IS DISTINCT FROM NEW."adapterConfigDigest"
      OR hold_row."settledMicroUsd" IS NULL
      OR hold_row."dispatchIntentId" IS NULL
      OR hold_row."dispatchAuditLogId" IS NULL
      OR hold_row."settlementObservationId" IS NULL
      OR hold_row."settlementAuditLogId" IS NULL
      OR hold_row."dispatchedAt" IS NULL
      OR hold_row."closedAt" IS NULL
      OR hold_row."unknownAt" IS NOT NULL THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_result_binding_invalid';
    END IF;

    NEW."createdAt" := db_now;
    NEW."expiresAt" := LEAST(attempt_row."expiresAt", db_now + INTERVAL '5 minutes');
    IF NEW."publishDeadlineAt" > hold_row."dispatchedAt" + INTERVAL '13 seconds'
      OR db_now_tz >= NEW."publishDeadlineAt"
      OR NEW."expiresAt" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_result_late';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE'
    OR OLD."state" IS DISTINCT FROM 'ready'
    OR NEW."state" NOT IN ('consumed', 'stale')
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
    OR NEW."scopeId" IS DISTINCT FROM OLD."scopeId"
    OR NEW."scopeEpoch" IS DISTINCT FROM OLD."scopeEpoch"
    OR NEW."recoveryEpoch" IS DISTINCT FROM OLD."recoveryEpoch"
    OR NEW."draftId" IS DISTINCT FROM OLD."draftId"
    OR NEW."draftRevision" IS DISTINCT FROM OLD."draftRevision"
    OR NEW."sourceMessageId" IS DISTINCT FROM OLD."sourceMessageId"
    OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
    OR NEW."promptVersion" IS DISTINCT FROM OLD."promptVersion"
    OR NEW."candidateDigest" IS DISTINCT FROM OLD."candidateDigest"
    OR NEW."adapterConfigDigest" IS DISTINCT FROM OLD."adapterConfigDigest"
    OR NEW."pricePinDigest" IS DISTINCT FROM OLD."pricePinDigest"
    OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
    OR NEW."holdId" IS DISTINCT FROM OLD."holdId"
    OR NEW."analysisKind" IS DISTINCT FROM OLD."analysisKind"
    OR NEW."analysisDifficulty" IS DISTINCT FROM OLD."analysisDifficulty"
    OR NEW."expectedOutputLength" IS DISTINCT FROM OLD."expectedOutputLength"
    OR NEW."needsCurrentInformation" IS DISTINCT FROM OLD."needsCurrentInformation"
    OR NEW."rewriteDecision" IS DISTINCT FROM OLD."rewriteDecision"
    OR NEW."publishDeadlineAt" IS DISTINCT FROM OLD."publishDeadlineAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."sourcePrompt" IS NOT NULL
    OR NEW."rewritePrompt" IS NOT NULL THEN
    RAISE EXCEPTION 'chat_unified_router_refiner_result_transition_invalid';
  END IF;

  IF NEW."state" = 'consumed' THEN
    db_now := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
    IF db_now >= OLD."expiresAt" THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_result_late';
    END IF;
    NEW."consumedAt" := db_now;
  ELSE
    NEW."consumedAt" := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_guard"
  BEFORE INSERT OR UPDATE ON "ChatUnifiedRouterRefinerResult"
  FOR EACH ROW EXECUTE FUNCTION "guard_chat_unified_router_refiner_result"();

-- Replace the old local held shape with a permissive local check. The exact
-- legacy-suggestion XOR unified-result invariant is enforced by both the
-- immediate attempt guard and deferred cross-table checks below.
DO $$
DECLARE held_constraint_name TEXT; held_constraint_count INTEGER;
BEGIN
  SELECT MIN(c.conname), COUNT(*)::INTEGER
    INTO held_constraint_name, held_constraint_count
  FROM pg_constraint c
  JOIN pg_attribute state_column
    ON state_column.attrelid = c.conrelid AND state_column.attname = 'state'
  JOIN pg_attribute suggestion_column
    ON suggestion_column.attrelid = c.conrelid
      AND suggestion_column.attname = 'suggestionId'
  WHERE c.conrelid = '"PromptRefinerProductAttempt"'::regclass
    AND c.contype = 'c'
    AND c.conkey @> ARRAY[state_column.attnum, suggestion_column.attnum]::SMALLINT[]
    AND cardinality(c.conkey) = 2;
  IF held_constraint_count <> 1 OR held_constraint_name IS NULL THEN
    RAISE EXCEPTION 'prompt_refiner_product_attempt_held_constraint_missing';
  END IF;
  EXECUTE format('ALTER TABLE "PromptRefinerProductAttempt" DROP CONSTRAINT %I',
    held_constraint_name);
END $$;

ALTER TABLE "PromptRefinerProductAttempt"
  ADD CONSTRAINT "PromptRefinerProductAttempt_held_authority_shape_check" CHECK (
    "state" = 'held' OR "suggestionId" IS NULL);

CREATE OR REPLACE FUNCTION "guard_prompt_refiner_product_attempt"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  scope_row "PromptRefinerChatScope";
  draft_row "ChatComposerDraft";
  suggestion_row "PromptRefinerChatSuggestion";
  unified_row "ChatUnifiedRouterRefinerResult";
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
    OR OLD."sourceMessageId" IS NOT NULL
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    -- Legacy held attempts retain their one later source binding mutation.
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

  SELECT * INTO unified_row FROM "ChatUnifiedRouterRefinerResult"
    WHERE "attemptId" = NEW."id" FOR SHARE;
  IF NEW."state" = 'held' THEN
    IF (NEW."suggestionId" IS NULL) = (unified_row."id" IS NULL) THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_held_authority_invalid';
    END IF;
    IF NEW."suggestionId" IS NOT NULL THEN
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
        OR suggestion_row."state" IS DISTINCT FROM 'ready'
        OR NEW."sourceMessageId" IS NOT NULL THEN
        RAISE EXCEPTION 'prompt_refiner_product_attempt_suggestion_invalid';
      END IF;
    ELSIF unified_row."attemptId" IS DISTINCT FROM NEW."id"
      OR unified_row."userId" IS DISTINCT FROM NEW."userId"
      OR unified_row."conversationId" IS DISTINCT FROM NEW."conversationId"
      OR unified_row."scopeId" IS DISTINCT FROM NEW."scopeId"
      OR unified_row."scopeEpoch" IS DISTINCT FROM NEW."scopeEpoch"
      OR unified_row."draftId" IS DISTINCT FROM NEW."draftId"
      OR unified_row."draftRevision" IS DISTINCT FROM NEW."draftRevision"
      OR unified_row."sourceMessageId" IS DISTINCT FROM NEW."sourceMessageId"
      OR NEW."sourceMessageId" IS DISTINCT FROM
        "chat_unified_router_refiner_source_message_id"(
          NEW."conversationId", NEW."clientRequestId")
      OR unified_row."state" IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_unified_result_invalid';
    END IF;
  ELSIF NEW."suggestionId" IS NOT NULL OR unified_row."id" IS NOT NULL
    OR NEW."sourceMessageId" IS NOT NULL THEN
    RAISE EXCEPTION 'prompt_refiner_product_attempt_terminal_authority_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "assert_prompt_refiner_product_attempt_held_authority"(
  checked_attempt_id TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  attempt_state TEXT;
  suggestion_id TEXT;
  attempt_source_message_id TEXT;
  unified_count INTEGER;
  unified_source_message_id TEXT;
BEGIN
  SELECT a."state", a."suggestionId", a."sourceMessageId"
    INTO attempt_state, suggestion_id, attempt_source_message_id
    FROM "PromptRefinerProductAttempt" a WHERE a."id" = checked_attempt_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COUNT(*)::INTEGER INTO unified_count
    FROM "ChatUnifiedRouterRefinerResult" r
    WHERE r."attemptId" = checked_attempt_id;
  IF attempt_state = 'held' THEN
    IF ((suggestion_id IS NOT NULL)::INTEGER + unified_count) <> 1 THEN
      RAISE EXCEPTION 'prompt_refiner_product_attempt_held_authority_invalid';
    END IF;
    IF suggestion_id IS NULL THEN
      SELECT r."sourceMessageId" INTO unified_source_message_id
        FROM "ChatUnifiedRouterRefinerResult" r
        WHERE r."attemptId" = checked_attempt_id;
      IF attempt_source_message_id IS NULL OR
          unified_source_message_id IS DISTINCT FROM attempt_source_message_id THEN
        RAISE EXCEPTION 'prompt_refiner_product_attempt_source_binding_invalid';
      END IF;
    END IF;
  ELSIF suggestion_id IS NOT NULL OR unified_count <> 0 THEN
    RAISE EXCEPTION 'prompt_refiner_product_attempt_nonheld_authority_invalid';
  END IF;
END $$;

CREATE FUNCTION "check_prompt_refiner_product_attempt_held_authority"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  result_state TEXT;
  publish_deadline_at TIMESTAMPTZ(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "assert_prompt_refiner_product_attempt_held_authority"(OLD."id");
  ELSE
    PERFORM "assert_prompt_refiner_product_attempt_held_authority"(NEW."id");
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" = 'preparing' AND NEW."state" = 'held'
      AND NEW."suggestionId" IS NULL THEN
    SELECT r."state", r."publishDeadlineAt"
      INTO result_state, publish_deadline_at
      FROM "ChatUnifiedRouterRefinerResult" r WHERE r."attemptId" = NEW."id";
    IF result_state IS DISTINCT FROM 'ready' OR publish_deadline_at IS NULL
        OR clock_timestamp() >= publish_deadline_at THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_result_late';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "PromptRefinerProductAttempt_held_authority_exact"
  AFTER INSERT OR UPDATE OR DELETE ON "PromptRefinerProductAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_prompt_refiner_product_attempt_held_authority"();

CREATE FUNCTION "check_chat_unified_router_refiner_result_held_authority"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  current_state TEXT;
  publish_deadline_at TIMESTAMPTZ(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM "assert_prompt_refiner_product_attempt_held_authority"(OLD."attemptId");
  END IF;
  IF TG_OP <> 'DELETE' AND
      (TG_OP = 'INSERT' OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId") THEN
    PERFORM "assert_prompt_refiner_product_attempt_held_authority"(NEW."attemptId");
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r."state", r."publishDeadlineAt"
      INTO current_state, publish_deadline_at
      FROM "ChatUnifiedRouterRefinerResult" r WHERE r."id" = NEW."id";
    IF current_state IS DISTINCT FROM 'ready' OR publish_deadline_at IS NULL
        OR clock_timestamp() >= publish_deadline_at THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_result_late';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "ChatUnifiedRouterRefinerResult_held_authority_exact"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatUnifiedRouterRefinerResult"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_chat_unified_router_refiner_result_held_authority"();

CREATE FUNCTION "stale_chat_unified_router_refiner_result_for_draft"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."revision" IS DISTINCT FROM OLD."revision"
      OR NEW."text" IS DISTINCT FROM OLD."text" THEN
    UPDATE "ChatUnifiedRouterRefinerResult"
      SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
      WHERE "draftId" = OLD."id" AND "state" = 'ready';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_draft_edit"
  AFTER UPDATE ON "ChatComposerDraft" FOR EACH ROW
  EXECUTE FUNCTION "stale_chat_unified_router_refiner_result_for_draft"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedRouterRefinerResult_draft_delete"
  AFTER DELETE ON "ChatComposerDraft" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "stale_chat_unified_router_refiner_result_for_draft"();

CREATE FUNCTION "stale_chat_unified_router_refiner_result_for_scope"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ChatUnifiedRouterRefinerResult"
    SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
    WHERE "scopeId" = OLD."id" AND "state" = 'ready';
  RETURN NULL;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_scope_advance"
  AFTER UPDATE ON "PromptRefinerChatScope" FOR EACH ROW
  EXECUTE FUNCTION "stale_chat_unified_router_refiner_result_for_scope"();

CREATE FUNCTION "stale_chat_unified_router_refiner_result_for_recovery"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."chatRecoveryEpoch" IS DISTINCT FROM OLD."chatRecoveryEpoch" THEN
    UPDATE "ChatUnifiedRouterRefinerResult"
      SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
      WHERE "conversationId" = OLD."id" AND "state" = 'ready';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_recovery_advance"
  AFTER UPDATE ON "Conversation" FOR EACH ROW
  EXECUTE FUNCTION "stale_chat_unified_router_refiner_result_for_recovery"();

CREATE FUNCTION "reject_chat_unified_router_refiner_result_truncate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat_unified_router_refiner_result_truncate_forbidden';
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_no_truncate"
  BEFORE TRUNCATE ON "ChatUnifiedRouterRefinerResult"
  FOR EACH STATEMENT EXECUTE FUNCTION
    "reject_chat_unified_router_refiner_result_truncate"();
