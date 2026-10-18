-- U27 repair: each deferred trigger must select its table branch before it
-- reads fields from the polymorphic NEW record. The original function read
-- NEW.revision while handling a receipt row, which PostgreSQL rejects.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  candidate_row "ChatUnifiedOptimizerCandidate"%ROWTYPE;
  audit_ok BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerActivePointer' THEN
    IF NEW."revision" = 0 THEN
      RETURN NULL;
    END IF;
    pointer_row := NEW;
    SELECT * INTO receipt_row FROM "ChatUnifiedOptimizerPromotionReceipt"
      WHERE "requestId" = NEW."promotionRequestId";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerPromotionReceipt' THEN
    receipt_row := NEW;
    SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
      WHERE "productKey" = NEW."productKey";
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_trigger_refused';
  END IF;
  IF receipt_row."id" IS NULL OR pointer_row."productKey" IS NULL
     OR pointer_row."revision" <> receipt_row."toRevision"
     OR pointer_row."promotionRequestId" <> receipt_row."requestId"
     OR pointer_row."promotionAuditLogId" <> receipt_row."auditLogId"
     OR pointer_row."candidateId" <> receipt_row."candidateId"
     OR pointer_row."candidateDigest" <> receipt_row."candidateDigest"
     OR pointer_row."bundleDigest" <> receipt_row."candidateBundleDigest"
     OR pointer_row."sourceSha" <> receipt_row."sourceSha"
     OR pointer_row."baseSha" <> receipt_row."baseSha"
     OR pointer_row."schemaVersion" <> receipt_row."schemaVersion"
     OR pointer_row."schemaDigest" <> receipt_row."schemaDigest"
     OR pointer_row."promptVersion" <> receipt_row."promptVersion"
     OR pointer_row."controlsDigest" <> receipt_row."controlsDigest"
     OR pointer_row."policyVersion" <> receipt_row."policyVersion"
     OR pointer_row."protocolDigest" <> receipt_row."protocolDigest"
     OR pointer_row."authorizationExpiresAt" <>
       receipt_row."authorizationExpiresAt"
     OR clock_timestamp() >= receipt_row."authorizationExpiresAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_binding_refused';
  END IF;
  SELECT * INTO candidate_row FROM "ChatUnifiedOptimizerCandidate"
    WHERE "id" = receipt_row."candidateId";
  IF candidate_row."id" IS NULL
     OR candidate_row."cycleId" <> receipt_row."cycleId"
     OR candidate_row."candidateDigest" <> receipt_row."candidateDigest"
     OR candidate_row."bundleDigest" <> receipt_row."candidateBundleDigest"
     OR candidate_row."controlsDigest" <> receipt_row."controlsDigest"
     OR candidate_row."schemaVersion" <> receipt_row."schemaVersion"
     OR candidate_row."promptVersion" <> receipt_row."promptVersion"
     OR candidate_row."sourceCommitSha" <> receipt_row."sourceSha"
     OR candidate_row."runtimeAuthorized" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_candidate_refused';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "AdminAuditLog" a
    WHERE a."id" = receipt_row."auditLogId"
      AND a."action" = 'chat.unified_optimizer.candidate_pointer_prepared'
      AND a."targetType" = 'ChatUnifiedOptimizerPromotionReceipt'
      AND a."targetId" = receipt_row."id"::text
      AND a."metadata"->>'systemActor' = 'chat-unified-candidate-promoter'
      AND a."metadata"->>'requestId' = receipt_row."requestId"::text
      AND a."metadata"->>'requestDigest' = receipt_row."requestDigest"
      AND a."metadata"->>'fromRevision' = receipt_row."fromRevision"::text
      AND a."metadata"->>'toRevision' = receipt_row."toRevision"::text
      AND a."metadata"->>'candidateDigest' = receipt_row."candidateDigest"
      AND a."metadata"->>'runtimeAuthorized' = 'false'
  ) INTO audit_ok;
  IF NOT audit_ok THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_audit_refused';
  END IF;
  RETURN NULL;
END;
$$;
