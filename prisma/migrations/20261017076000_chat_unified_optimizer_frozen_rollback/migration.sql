-- Signed later-candidate rollback may restore the exact prior active-100 bundle.
-- A rollback snapshot may represent a live restored bundle. The pointer
-- transition and deferred audit guards below are its only creation path.
ALTER TABLE "ChatUnifiedOptimizerPointerSnapshot"
  DROP CONSTRAINT "ChatUnifiedOptimizerPointerSnapshot_closed_check";
ALTER TABLE "ChatUnifiedOptimizerPointerSnapshot"
  ADD CONSTRAINT "ChatUnifiedOptimizerPointerSnapshot_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "revision" >= 0
    AND "incumbentKind" IN ('legacy_path', 'active_frozen_bundle')
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND ("bundleDigest" IS NULL OR "bundleDigest" ~ '^[0-9a-f]{64}$')
    AND (NOT "runtimeAuthorized" OR "incumbentKind" = 'active_frozen_bundle')
    AND (("incumbentKind" = 'legacy_path' AND "candidateId" IS NULL
      AND "bundleDigest" IS NULL)
      OR ("incumbentKind" = 'active_frozen_bundle'
        AND "candidateId" IS NOT NULL AND "bundleDigest" IS NOT NULL))
  );
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_pointer_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  promotion_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  rollback_row "ChatUnifiedOptimizerRollbackReceipt"%ROWTYPE;
  rollout_row "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  failed_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  prior_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  prior_rollout "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
  prior_cycle_state TEXT;
  stop_value TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_delete_refused';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 OR NEW."incumbentKind" <> 'legacy_path'
       OR NEW."candidateId" IS NOT NULL OR NEW."bundleDigest" IS NOT NULL
       OR NEW."runtimeAuthorized" THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_pointer_bootstrap_refused';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."revision" = OLD."revision" THEN
    SELECT * INTO rollout_row FROM "ChatUnifiedOptimizerCanaryRollout"
      WHERE "productKey" = NEW."productKey"
        AND "pointerRevision" = NEW."revision";
    IF OLD."runtimeAuthorized" OR NOT NEW."runtimeAuthorized"
       OR rollout_row."promotionReceiptId" IS NULL
       OR rollout_row."phase" <> 'candidate_5'
       OR rollout_row."phaseRevision" <> 1
       OR rollout_row."activationAuditLogId" IS NULL
       OR NEW."incumbentKind" <> 'active_frozen_bundle'
       OR ROW(NEW."productKey", NEW."incumbentKind", NEW."candidateId",
         NEW."candidateDigest", NEW."bundleDigest", NEW."sourceSha",
         NEW."baseSha", NEW."schemaVersion", NEW."schemaDigest",
         NEW."promptVersion", NEW."controlsDigest", NEW."policyVersion",
         NEW."protocolDigest", NEW."authorizationExpiresAt",
         NEW."promotionRequestId", NEW."promotionAuditLogId")
         IS DISTINCT FROM
         ROW(OLD."productKey", OLD."incumbentKind", OLD."candidateId",
           OLD."candidateDigest", OLD."bundleDigest", OLD."sourceSha",
           OLD."baseSha", OLD."schemaVersion", OLD."schemaDigest",
           OLD."promptVersion", OLD."controlsDigest", OLD."policyVersion",
           OLD."protocolDigest", OLD."authorizationExpiresAt",
           OLD."promotionRequestId", OLD."promotionAuditLogId") OR
       ROW(rollout_row."candidateId", rollout_row."candidateDigest",
         rollout_row."bundleDigest") IS DISTINCT FROM
       ROW(NEW."candidateId", NEW."candidateDigest", NEW."bundleDigest") THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_pointer_activation_refused';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."productKey" <> OLD."productKey"
     OR NEW."revision" <> OLD."revision" + 1
     OR NEW."promotionRequestId" = OLD."promotionRequestId"
     OR NEW."promotionAuditLogId" = OLD."promotionAuditLogId" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_transition_refused';
  END IF;
  SELECT * INTO rollback_row FROM "ChatUnifiedOptimizerRollbackReceipt"
    WHERE "requestId" = NEW."promotionRequestId";
  IF rollback_row."id" IS NOT NULL THEN
    SELECT * INTO failed_row FROM "ChatUnifiedOptimizerPromotionReceipt"
      WHERE "requestId" = OLD."promotionRequestId";
    SELECT * INTO target_row FROM "ChatUnifiedOptimizerPointerSnapshot"
      WHERE "productKey" = OLD."productKey"
        AND "revision" = OLD."revision" - 1;
    SELECT * INTO rollout_row FROM "ChatUnifiedOptimizerCanaryRollout"
      WHERE "productKey" = OLD."productKey"
        AND "pointerRevision" = OLD."revision";
    IF OLD."runtimeAuthorized" AND
       rollback_row."targetKind" = 'active_frozen_bundle' THEN
      SELECT * INTO prior_row FROM "ChatUnifiedOptimizerPromotionReceipt"
        WHERE "requestId" = target_row."promotionRequestId";
      SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
        WHERE "promotionReceiptId" = prior_row."id";
      SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
        WHERE "id" = prior_row."cycleId";
      SELECT "value" INTO stop_value FROM "AppSetting"
        WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
      IF prior_row."id" IS NULL
         OR prior_row."toRevision" <> target_row."revision"
         OR prior_row."candidateId" <> target_row."candidateId"
         OR prior_row."candidateDigest" <> target_row."candidateDigest"
         OR prior_row."candidateBundleDigest" <> target_row."bundleDigest"
         OR prior_rollout."promotionReceiptId" IS NULL
         OR prior_rollout."productKey" <> OLD."productKey"
         OR prior_rollout."pointerRevision" <> target_row."revision"
         OR prior_rollout."cycleId" <> prior_row."cycleId"
         OR prior_rollout."candidateId" <> target_row."candidateId"
         OR prior_rollout."candidateDigest" <> target_row."candidateDigest"
         OR prior_rollout."bundleDigest" <> target_row."bundleDigest"
         OR prior_rollout."phase" <> 'active_100'
         OR prior_rollout."phaseRevision" < 4
         OR prior_rollout."activationAuditLogId" IS NULL
         OR prior_cycle_state IS DISTINCT FROM 'succeeded'
         OR stop_value IS NOT NULL
         OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
           WHERE "cycleId" = prior_row."cycleId") THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'chat_unified_optimizer_frozen_rollback_refused';
      END IF;
    END IF;
    IF failed_row."id" IS NULL OR target_row."productKey" IS NULL
       OR NEW."runtimeAuthorized" IS DISTINCT FROM
         (OLD."runtimeAuthorized" AND
           rollback_row."targetKind" = 'active_frozen_bundle')
       OR (OLD."runtimeAuthorized" AND
         (rollout_row."promotionReceiptId" IS NULL
           OR rollout_row."promotionReceiptId" <> failed_row."id"
           OR rollout_row."candidateId" <> OLD."candidateId"
           OR rollout_row."candidateDigest" <> OLD."candidateDigest"
           OR rollout_row."bundleDigest" <> OLD."bundleDigest"
           OR rollout_row."phase" NOT IN ('candidate_5', 'candidate_25',
             'candidate_90', 'active_100')
           OR rollout_row."phaseRevision" < 1
           OR rollout_row."activationAuditLogId" IS NULL))
       OR rollback_row."productKey" <> OLD."productKey"
       OR rollback_row."fromRevision" <> OLD."revision"
       OR rollback_row."toRevision" <> NEW."revision"
       OR rollback_row."targetRevision" <> target_row."revision"
       OR rollback_row."failedPromotionId" <> failed_row."id"
       OR rollback_row."failedCandidateId" <> OLD."candidateId"
       OR rollback_row."failedCycleId" <> failed_row."cycleId"
       OR rollback_row."targetKind" <> target_row."incumbentKind"
       OR rollback_row."targetCandidateId" IS DISTINCT FROM
         target_row."candidateId"
       OR rollback_row."targetDigest" <>
         (CASE WHEN target_row."incumbentKind" = 'legacy_path'
           THEN target_row."candidateDigest" ELSE target_row."bundleDigest" END)
       OR rollback_row."auditLogId" <> NEW."promotionAuditLogId"
       OR failed_row."incumbentDigest" <> rollback_row."targetDigest"
       OR ROW(NEW."incumbentKind", NEW."candidateId",
         NEW."candidateDigest", NEW."bundleDigest", NEW."sourceSha",
         NEW."baseSha", NEW."schemaVersion", NEW."schemaDigest",
         NEW."promptVersion", NEW."controlsDigest", NEW."policyVersion",
         NEW."protocolDigest", NEW."authorizationExpiresAt")
         IS DISTINCT FROM
         ROW(target_row."incumbentKind", target_row."candidateId",
           target_row."candidateDigest", target_row."bundleDigest",
           target_row."sourceSha", target_row."baseSha",
           target_row."schemaVersion", target_row."schemaDigest",
           target_row."promptVersion", target_row."controlsDigest",
           target_row."policyVersion", target_row."protocolDigest",
           target_row."authorizationExpiresAt") THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_pointer_rollback_refused';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."runtimeAuthorized" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_transition_refused';
  END IF;
  IF OLD."runtimeAuthorized" THEN
    SELECT * INTO prior_row FROM "ChatUnifiedOptimizerPromotionReceipt"
      WHERE "requestId" = OLD."promotionRequestId";
    SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
      WHERE "promotionReceiptId" = prior_row."id";
    SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
      WHERE "id" = prior_row."cycleId";
    SELECT "value" INTO stop_value FROM "AppSetting"
      WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
    IF OLD."incumbentKind" <> 'active_frozen_bundle'
       OR prior_row."id" IS NULL
       OR prior_row."toRevision" <> OLD."revision"
       OR prior_row."candidateId" <> OLD."candidateId"
       OR prior_row."candidateDigest" <> OLD."candidateDigest"
       OR prior_row."candidateBundleDigest" <> OLD."bundleDigest"
       OR prior_rollout."promotionReceiptId" IS NULL
       OR prior_rollout."productKey" <> OLD."productKey"
       OR prior_rollout."pointerRevision" <> OLD."revision"
       OR prior_rollout."cycleId" <> prior_row."cycleId"
       OR prior_rollout."candidateId" <> OLD."candidateId"
       OR prior_rollout."candidateDigest" <> OLD."candidateDigest"
       OR prior_rollout."bundleDigest" <> OLD."bundleDigest"
       OR prior_rollout."phase" <> 'active_100'
       OR prior_rollout."phaseRevision" < 4
       OR prior_rollout."activationAuditLogId" IS NULL
       OR prior_cycle_state IS DISTINCT FROM 'succeeded'
       OR stop_value IS NOT NULL
       OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
         WHERE "cycleId" = prior_row."cycleId") THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_active_promotion_refused';
    END IF;
  END IF;
  IF NEW."incumbentKind" <> 'active_frozen_bundle'
     OR NEW."candidateId" IS NULL OR NEW."bundleDigest" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_transition_refused';
  END IF;
  SELECT * INTO promotion_row FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "requestId" = NEW."promotionRequestId";
  IF promotion_row."id" IS NULL
     OR promotion_row."productKey" <> OLD."productKey"
     OR promotion_row."fromRevision" <> OLD."revision"
     OR promotion_row."toRevision" <> NEW."revision"
     OR promotion_row."incumbentKind" <> OLD."incumbentKind"
     OR promotion_row."incumbentDigest" <>
       (CASE WHEN OLD."incumbentKind" = 'legacy_path'
         THEN OLD."candidateDigest" ELSE OLD."bundleDigest" END) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_incumbent_refused';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  rollback_row "ChatUnifiedOptimizerRollbackReceipt"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  candidate_row "ChatUnifiedOptimizerCandidate"%ROWTYPE;
  latch_row "ChatUnifiedOptimizerCycleLatch"%ROWTYPE;
  audit_ok BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerActivePointer' THEN
    IF NEW."revision" = 0 THEN RETURN NULL; END IF;
    pointer_row := NEW;
    SELECT * INTO rollback_row FROM "ChatUnifiedOptimizerRollbackReceipt"
      WHERE "requestId" = NEW."promotionRequestId";
    IF rollback_row."id" IS NULL THEN
      SELECT * INTO receipt_row FROM "ChatUnifiedOptimizerPromotionReceipt"
        WHERE "requestId" = NEW."promotionRequestId";
    END IF;
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerPromotionReceipt' THEN
    receipt_row := NEW;
    SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
      WHERE "productKey" = NEW."productKey";
  ELSIF TG_TABLE_NAME = 'ChatUnifiedOptimizerRollbackReceipt' THEN
    rollback_row := NEW;
    SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
      WHERE "productKey" = NEW."productKey";
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_trigger_refused';
  END IF;
  IF rollback_row."id" IS NOT NULL THEN
    SELECT * INTO target_row FROM "ChatUnifiedOptimizerPointerSnapshot"
      WHERE "productKey" = rollback_row."productKey"
        AND "revision" = rollback_row."targetRevision";
    SELECT * INTO latch_row FROM "ChatUnifiedOptimizerCycleLatch"
      WHERE "cycleId" = rollback_row."failedCycleId";
    SELECT EXISTS (SELECT 1 FROM "AdminAuditLog" a
      WHERE a."id" = rollback_row."auditLogId"
        AND a."action" = 'chat.unified_candidate.rolled_back'
        AND a."targetType" = 'ChatUnifiedOptimizerRollbackReceipt'
        AND a."targetId" = rollback_row."id"::text
        AND a."metadata"->>'systemActor' =
          'chat-unified-candidate-promoter'
        AND a."metadata"->>'requestId' = rollback_row."requestId"::text
        AND a."metadata"->>'requestDigest' =
          rollback_row."requestDigest"
        AND a."metadata"->>'fromRevision' =
          rollback_row."fromRevision"::text
        AND a."metadata"->>'toRevision' =
          rollback_row."toRevision"::text
        AND a."metadata"->>'evidenceDigest' =
          rollback_row."evidenceDigest"
      ) INTO audit_ok;
    IF pointer_row."productKey" IS NULL OR target_row."productKey" IS NULL
       OR latch_row."cycleId" IS NULL OR NOT audit_ok
       OR pointer_row."revision" <> rollback_row."toRevision"
       OR pointer_row."promotionRequestId" <> rollback_row."requestId"
       OR pointer_row."promotionAuditLogId" <> rollback_row."auditLogId"
       OR (pointer_row."runtimeAuthorized" AND
         rollback_row."targetKind" <> 'active_frozen_bundle')
       OR pointer_row."candidateId" IS DISTINCT FROM
          target_row."candidateId"
       OR pointer_row."candidateDigest" <> target_row."candidateDigest"
       OR pointer_row."bundleDigest" IS DISTINCT FROM
          target_row."bundleDigest"
       OR latch_row."rollbackId" <> rollback_row."id"
       OR NOT EXISTS (SELECT 1 FROM "AdminAuditLog" a
         WHERE a."id" = latch_row."auditLogId"
           AND a."action" = 'chat.unified_candidate.cycle_latched'
           AND a."targetType" = 'ChatUnifiedOptimizerCycleLatch'
           AND a."targetId" = latch_row."cycleId"::text
           AND a."metadata"->>'systemActor' =
             'chat-unified-candidate-promoter'
           AND a."metadata"->>'rollbackId' = rollback_row."id"::text)
       THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_rollback_binding_refused';
    END IF;
    RETURN NULL;
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
     OR candidate_row."runtimeAuthorized"
     OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch" l
       WHERE l."cycleId" = receipt_row."cycleId") THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_candidate_refused';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "AdminAuditLog" a
    WHERE a."id" = receipt_row."auditLogId"
      AND a."action" = 'chat.unified_optimizer.candidate_pointer_prepared'
      AND a."targetType" = 'ChatUnifiedOptimizerPromotionReceipt'
      AND a."targetId" = receipt_row."id"::text
      AND a."metadata"->>'systemActor' =
        'chat-unified-candidate-promoter'
      AND a."metadata"->>'requestId' = receipt_row."requestId"::text
      AND a."metadata"->>'requestDigest' = receipt_row."requestDigest"
      AND a."metadata"->>'fromRevision' = receipt_row."fromRevision"::text
      AND a."metadata"->>'toRevision' = receipt_row."toRevision"::text
      AND a."metadata"->>'candidateDigest' =
        receipt_row."candidateDigest"
      AND a."metadata"->>'runtimeAuthorized' = 'false'
  ) INTO audit_ok;
  IF NOT audit_ok THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_promotion_audit_refused';
  END IF;
  RETURN NULL;
END;
$$;
