-- Close the prepared-rollout invariant before any live phase writer exists.
-- Existing receipts without an exact rollout require operator readback; a
-- migration must not invent their audit evidence or cohort salt.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerPromotionReceipt" r
    LEFT JOIN "ChatUnifiedOptimizerCanaryRollout" cr
      ON cr."promotionReceiptId" = r."id"
    WHERE cr."promotionReceiptId" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_legacy_receipt_readback_required';
  END IF;
END;
$$;

ALTER TABLE "ChatUnifiedOptimizerCanaryRollout"
  ADD CONSTRAINT "ChatUnifiedOptimizerCanaryRollout_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prepared rows are immutable. U35 must replace this guard with a reviewed
-- exact owner-activation/phase-CAS transition before any rollout can start.
CREATE FUNCTION "chat_unified_optimizer_canary_rollout_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  candidate "ChatUnifiedOptimizerCandidate"%ROWTYPE;
  pointer "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_rollout_immutable';
  END IF;

  SELECT * INTO receipt FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "id" = NEW."promotionReceiptId";
  SELECT * INTO candidate FROM "ChatUnifiedOptimizerCandidate"
    WHERE "id" = NEW."candidateId";
  SELECT * INTO pointer FROM "ChatUnifiedOptimizerActivePointer"
    WHERE "productKey" = NEW."productKey";
  SELECT * INTO audit FROM "AdminAuditLog"
    WHERE "id" = NEW."lastAuditLogId";

  IF receipt."id" IS NULL OR candidate."id" IS NULL OR
      pointer."productKey" IS NULL OR audit."id" IS NULL OR
      receipt."runtimeAuthorized" OR pointer."runtimeAuthorized" OR
      ROW(receipt."productKey", receipt."toRevision", receipt."cycleId",
        receipt."candidateId", receipt."candidateDigest",
        receipt."candidateBundleDigest") IS DISTINCT FROM
      ROW(NEW."productKey", NEW."pointerRevision", NEW."cycleId",
        NEW."candidateId", NEW."candidateDigest", NEW."bundleDigest") OR
      ROW(candidate."cycleId", candidate."candidateDigest",
        candidate."bundleDigest") IS DISTINCT FROM
      ROW(NEW."cycleId", NEW."candidateDigest", NEW."bundleDigest") OR
      ROW(pointer."revision", pointer."candidateId",
        pointer."candidateDigest", pointer."bundleDigest",
        pointer."promotionRequestId") IS DISTINCT FROM
      ROW(NEW."pointerRevision", NEW."candidateId",
        NEW."candidateDigest", NEW."bundleDigest",
        receipt."requestId") OR
      audit."action" IS DISTINCT FROM
        'chat.unified_optimizer.canary_rollout_prepared' OR
      audit."targetType" IS DISTINCT FROM
        'ChatUnifiedOptimizerCanaryRollout' OR
      audit."targetId" IS DISTINCT FROM NEW."promotionReceiptId"::text OR
      audit."actorUserId" IS NOT NULL OR audit."entryHash" IS NULL OR
      audit."metadata"->>'systemActor' IS DISTINCT FROM
        'chat-unified-candidate-promoter' OR
      audit."metadata"->>'promotionReceiptId' IS DISTINCT FROM
        NEW."promotionReceiptId"::text OR
      audit."metadata"->>'pointerRevision' IS DISTINCT FROM
        NEW."pointerRevision"::text OR
      audit."metadata"->>'candidateId' IS DISTINCT FROM
        NEW."candidateId"::text OR
      audit."metadata"->>'candidateDigest' IS DISTINCT FROM
        NEW."candidateDigest" OR
      audit."metadata"->>'bundleDigest' IS DISTINCT FROM
        NEW."bundleDigest" OR
      audit."metadata"->>'phase' IS DISTINCT FROM 'prepared' OR
      audit."metadata"->>'runtimeAuthorized' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_rollout_insert_refused';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "chat_unified_optimizer_canary_rollout_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerCanaryRollout"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_canary_rollout_guard"();

-- The promotion receipt and inert rollout must either both commit or neither
-- commit. The application inserts the receipt first and the rollout last.
CREATE FUNCTION "chat_unified_optimizer_canary_receipt_complete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerCanaryRollout" cr
    WHERE cr."promotionReceiptId" = NEW."id"
      AND cr."productKey" = NEW."productKey"
      AND cr."pointerRevision" = NEW."toRevision"
      AND cr."candidateId" = NEW."candidateId"
      AND cr."candidateDigest" = NEW."candidateDigest"
      AND cr."bundleDigest" = NEW."candidateBundleDigest"
      AND cr."phase" = 'prepared' AND cr."phaseRevision" = 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_receipt_incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "chat_unified_optimizer_canary_receipt_complete_trigger"
AFTER INSERT ON "ChatUnifiedOptimizerPromotionReceipt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_canary_receipt_complete"();

ALTER TABLE "ChatUnifiedOptimizerCanaryRollout" DROP COLUMN "updatedAt";
