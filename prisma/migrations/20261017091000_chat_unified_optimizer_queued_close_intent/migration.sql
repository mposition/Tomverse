-- A committed first-attempt fence survives a lost HTTP response. The
-- coordinator may read back the closure, but may not dispatch it twice.
CREATE TABLE "ChatUnifiedOptimizerQueuedCloseIntent" (
  "cycleId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "closeRequestDigest" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerQueuedCloseIntent_pkey" PRIMARY KEY ("cycleId"),
  CONSTRAINT "ChatUnifiedOptimizerQueuedCloseIntent_digest_check"
    CHECK ("closeRequestDigest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "ChatUnifiedOptimizerQueuedCloseIntent_requestId_key"
  ON "ChatUnifiedOptimizerQueuedCloseIntent"("requestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerQueuedCloseIntent_auditLogId_key"
  ON "ChatUnifiedOptimizerQueuedCloseIntent"("auditLogId");
ALTER TABLE "ChatUnifiedOptimizerQueuedCloseIntent"
  ADD CONSTRAINT "ChatUnifiedOptimizerQueuedCloseIntent_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ChatUnifiedOptimizerQueuedCloseIntent"
  ADD CONSTRAINT "ChatUnifiedOptimizerQueuedCloseIntent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "chat_unified_optimizer_queued_close_intent_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row "AdminAuditLog"%ROWTYPE;
DECLARE cycle_row "ChatUnifiedOptimizerCycle"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_queued_close_intent_immutable'
      USING ERRCODE = 'P0001';
  END IF;
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO cycle_row FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = NEW."cycleId" FOR UPDATE;
  SELECT * INTO audit_row FROM "AdminAuditLog"
    WHERE "id" = NEW."auditLogId" AND xmin = pg_current_xact_id()::xid;
  IF cycle_row."id" IS NULL OR cycle_row."state" <> 'active'
    OR NEW."createdAt" < cycle_row."deadlineAt"
    OR (SELECT COUNT(*) FROM "ChatUnifiedOptimizerRoleJob" j
        JOIN "ChatUnifiedOptimizerRun" r ON r."id" = j."runId"
        WHERE r."cycleId" = NEW."cycleId") <> 6
    OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerRoleJob" j
        JOIN "ChatUnifiedOptimizerRun" r ON r."id" = j."runId"
        WHERE r."cycleId" = NEW."cycleId"
          AND j."deadlineAt" IS DISTINCT FROM cycle_row."deadlineAt")
    OR audit_row."id" IS NULL
    OR audit_row."action" IS DISTINCT FROM 'chat.unified_optimizer.queued_closure_intended'
    OR audit_row."targetType" IS DISTINCT FROM 'ChatUnifiedOptimizerQueuedCloseIntent'
    OR audit_row."targetId" IS DISTINCT FROM NEW."cycleId"::text
    OR audit_row."actorUserId" IS NOT NULL
    OR audit_row."actorEmail" IS NOT NULL
    OR audit_row."ipAddress" IS NOT NULL
    OR audit_row."userAgent" IS NOT NULL
    OR audit_row."metadata"->>'systemActor' IS DISTINCT FROM 'chat-unified-optimizer'
    OR audit_row."metadata"->>'purpose' IS DISTINCT FROM 'provider_free_validation'
    OR audit_row."metadata"->>'closeRequestDigest' IS DISTINCT FROM NEW."closeRequestDigest"
    OR audit_row."metadata"->>'cycleId' IS DISTINCT FROM NEW."cycleId"::text
    OR audit_row."metadata"->>'externalDispatchAuthorized' IS DISTINCT FROM 'false'
    OR audit_row."metadata"->>'paidAuthorized' IS DISTINCT FROM 'false'
    OR audit_row."metadata"->>'promotionAuthorized' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'chat_unified_optimizer_queued_close_intent_invalid'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerQueuedCloseIntent_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerQueuedCloseIntent"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_queued_close_intent_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerQueuedCloseIntent_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerQueuedCloseIntent"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
