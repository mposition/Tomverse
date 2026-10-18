-- U11: bind unified consumption to the exact Auto-mode generation, durable
-- source Message and canonical audit entry. All additions remain dark until a
-- later product route explicitly selects this server-only path.

ALTER TABLE "Conversation"
  ADD COLUMN "chatUnifiedRouterRefinerModeEpoch" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatUnifiedRouterRefinerResult"
  ADD COLUMN "modeEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "consumptionAuditLogId" TEXT;

CREATE UNIQUE INDEX "ChatUnifiedRouterRefinerResult_consumptionAuditLogId_key"
  ON "ChatUnifiedRouterRefinerResult"("consumptionAuditLogId");

ALTER TABLE "ChatUnifiedRouterRefinerResult"
  ADD CONSTRAINT "ChatUnifiedRouterRefinerResult_consumptionAuditLogId_fkey"
  FOREIGN KEY ("consumptionAuditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ChatUnifiedRouterRefinerResult"
  DROP CONSTRAINT "ChatUnifiedRouterRefinerResult_state_body_check";
ALTER TABLE "ChatUnifiedRouterRefinerResult"
  ADD CONSTRAINT "ChatUnifiedRouterRefinerResult_state_body_check" CHECK (
    ("state" = 'ready' AND "sourcePrompt" IS NOT NULL
      AND "consumedAt" IS NULL AND "consumptionAuditLogId" IS NULL
      AND (("rewriteDecision" = 'keep_original' AND "rewritePrompt" IS NULL)
        OR ("rewriteDecision" = 'rewrite' AND "rewritePrompt" IS NOT NULL)))
    OR ("state" = 'consumed' AND "sourcePrompt" IS NULL
      AND "rewritePrompt" IS NULL AND "consumedAt" IS NOT NULL
      AND "consumptionAuditLogId" IS NOT NULL
      AND "consumedAt" < "expiresAt")
    OR ("state" = 'stale' AND "sourcePrompt" IS NULL
      AND "rewritePrompt" IS NULL AND "consumedAt" IS NULL
      AND "consumptionAuditLogId" IS NULL));

CREATE FUNCTION "fence_chat_unified_router_refiner_mode"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."chatUnifiedRouterRefinerModeEpoch" := 0;
    RETURN NEW;
  END IF;
  IF NEW."selectionMode" IS DISTINCT FROM OLD."selectionMode" THEN
    NEW."chatUnifiedRouterRefinerModeEpoch" :=
      OLD."chatUnifiedRouterRefinerModeEpoch" + 1;
  ELSIF NEW."chatUnifiedRouterRefinerModeEpoch" IS DISTINCT FROM
      OLD."chatUnifiedRouterRefinerModeEpoch" THEN
    RAISE EXCEPTION 'chat_unified_router_refiner_mode_epoch_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Conversation_chat_unified_router_refiner_mode_fence"
  BEFORE INSERT OR UPDATE ON "Conversation" FOR EACH ROW
  EXECUTE FUNCTION "fence_chat_unified_router_refiner_mode"();

CREATE FUNCTION "stale_chat_unified_router_refiner_result_for_mode"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."selectionMode" IS DISTINCT FROM OLD."selectionMode" THEN
    UPDATE "ChatUnifiedRouterRefinerResult"
      SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
      WHERE "conversationId" = OLD."id" AND "state" = 'ready';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_mode_advance"
  AFTER UPDATE ON "Conversation" FOR EACH ROW
  EXECUTE FUNCTION "stale_chat_unified_router_refiner_result_for_mode"();

CREATE FUNCTION "guard_chat_unified_router_refiner_consume"()
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
    IF OLD."consumptionAuditLogId" IS NOT NULL
      OR NEW."consumptionAuditLogId" IS NULL THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
    END IF;
    SELECT * INTO audit_row FROM "AdminAuditLog"
      WHERE "id" = NEW."consumptionAuditLogId" FOR SHARE;
    IF audit_row."id" IS NULL
      OR audit_row."action" IS DISTINCT FROM
        'prompt_refiner.product_attempt_transitioned'
      OR audit_row."targetType" IS DISTINCT FROM 'PromptRefinerProductAttempt'
      OR audit_row."targetId" IS DISTINCT FROM NEW."attemptId"
      OR audit_row."actorUserId" IS NOT NULL
      OR audit_row."actorEmail" IS NOT NULL
      OR audit_row."ipAddress" IS NOT NULL
      OR audit_row."userAgent" IS NOT NULL
      OR audit_row."entryHash" IS NULL
      OR audit_row."metadata"->>'systemActor' IS DISTINCT FROM
        'prompt-refiner-product-execution'
      OR audit_row."metadata"->>'authorityKind' IS DISTINCT FROM
        'unified_router_refiner'
      OR audit_row."metadata"->>'state' IS DISTINCT FROM 'consumed' THEN
      RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
    END IF;
  ELSIF NEW."consumptionAuditLogId" IS DISTINCT FROM
      OLD."consumptionAuditLogId" THEN
    RAISE EXCEPTION 'chat_unified_router_refiner_consume_audit_invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ChatUnifiedRouterRefinerResult_consume_guard"
  BEFORE INSERT OR UPDATE ON "ChatUnifiedRouterRefinerResult"
  FOR EACH ROW EXECUTE FUNCTION
    "guard_chat_unified_router_refiner_consume"();

-- A deferred draft delete is the normal Chat send sequence: the existing
-- draft is consumed before its canonical user Message is inserted in the same
-- transaction. Preserve a ready result only when that committed Message is the
-- exact server-bound source. Every other delete purges the ephemeral body.
CREATE OR REPLACE FUNCTION "stale_chat_unified_router_refiner_result_for_draft"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."revision" IS DISTINCT FROM OLD."revision"
        OR NEW."text" IS DISTINCT FROM OLD."text" THEN
      UPDATE "ChatUnifiedRouterRefinerResult"
        SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
        WHERE "draftId" = OLD."id" AND "state" = 'ready';
    END IF;
    RETURN NULL;
  END IF;

  UPDATE "ChatUnifiedRouterRefinerResult" r
    SET "state" = 'stale', "sourcePrompt" = NULL, "rewritePrompt" = NULL
    WHERE r."draftId" = OLD."id" AND r."state" = 'ready'
      AND NOT EXISTS (
        SELECT 1
        FROM "Message" m
        JOIN "Conversation" c ON c."id" = m."conversationId"
        JOIN "PromptRefinerChatScope" s ON s."id" = r."scopeId"
        JOIN "PromptRefinerProductAttempt" a ON a."id" = r."attemptId"
        WHERE m."id" = r."sourceMessageId"
          AND m."conversationId" = r."conversationId"
          AND m."role" = 'user' AND m."content" = r."sourcePrompt"
          AND c."userId" = r."userId" AND c."kind" = 'chat'
          AND c."productKey" = 'chat' AND c."selectionMode" = 'auto'
          AND c."chatRecoveryEpoch" = r."recoveryEpoch"
          AND c."chatUnifiedRouterRefinerModeEpoch" = r."modeEpoch"
          AND s."userId" = r."userId"
          AND s."conversationId" = r."conversationId"
          AND s."surface" = 'chat' AND s."epoch" = r."scopeEpoch"
          AND a."userId" = r."userId"
          AND a."conversationId" = r."conversationId"
          AND a."scopeId" = r."scopeId" AND a."scopeEpoch" = r."scopeEpoch"
          AND a."draftId" = r."draftId"
          AND a."draftRevision" = r."draftRevision"
          AND a."mode" = 'auto' AND a."state" = 'held'
          AND a."suggestionId" IS NULL
          AND a."sourceMessageId" = r."sourceMessageId"
          AND r."sourceMessageId" =
            "chat_unified_router_refiner_source_message_id"(
              r."conversationId", a."clientRequestId")
          AND OLD."userId" = r."userId"
          AND OLD."conversationId" = r."conversationId"
          AND OLD."scopeKey" = r."conversationId"
          AND OLD."revision" = r."draftRevision"
          AND OLD."text" = r."sourcePrompt");
  RETURN NULL;
END $$;
