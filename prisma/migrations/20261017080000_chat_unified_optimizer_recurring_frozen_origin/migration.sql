-- A restored active snapshot keeps the rollback request, not its original
-- promotion request. Follow only immutable, strictly older matching snapshots.
CREATE FUNCTION "chat_unified_optimizer_frozen_origin"(
  product_key TEXT, snapshot_revision INTEGER)
RETURNS UUID LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  current_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  promotion_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  rollback_row "ChatUnifiedOptimizerRollbackReceipt"%ROWTYPE;
  rollout_row "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
  cycle_state TEXT;
  expected_candidate UUID;
  expected_candidate_digest TEXT;
  expected_bundle_digest TEXT;
BEGIN
  SELECT * INTO current_row FROM "ChatUnifiedOptimizerPointerSnapshot"
    WHERE "productKey" = product_key AND "revision" = snapshot_revision;
  IF current_row."productKey" IS NULL OR snapshot_revision < 1
     OR current_row."incumbentKind" <> 'active_frozen_bundle'
     OR current_row."candidateId" IS NULL
     OR current_row."bundleDigest" IS NULL THEN RETURN NULL; END IF;
  expected_candidate := current_row."candidateId";
  expected_candidate_digest := current_row."candidateDigest";
  expected_bundle_digest := current_row."bundleDigest";
  LOOP
    IF current_row."incumbentKind" <> 'active_frozen_bundle'
       OR current_row."candidateId" IS DISTINCT FROM expected_candidate
       OR current_row."candidateDigest" IS DISTINCT FROM expected_candidate_digest
       OR current_row."bundleDigest" IS DISTINCT FROM expected_bundle_digest
       THEN RETURN NULL; END IF;
    SELECT * INTO promotion_row FROM "ChatUnifiedOptimizerPromotionReceipt"
      WHERE "requestId" = current_row."promotionRequestId";
    IF promotion_row."id" IS NOT NULL THEN
      IF current_row."runtimeAuthorized"
         OR promotion_row."productKey" IS DISTINCT FROM product_key
         OR promotion_row."toRevision" IS DISTINCT FROM current_row."revision"
         OR promotion_row."candidateId" IS DISTINCT FROM expected_candidate
         OR promotion_row."candidateDigest" IS DISTINCT FROM expected_candidate_digest
         OR promotion_row."candidateBundleDigest" IS DISTINCT FROM expected_bundle_digest
         OR promotion_row."auditLogId" IS DISTINCT FROM current_row."promotionAuditLogId"
         THEN RETURN NULL; END IF;
      SELECT * INTO rollout_row FROM "ChatUnifiedOptimizerCanaryRollout"
        WHERE "promotionReceiptId" = promotion_row."id";
      SELECT "state" INTO cycle_state FROM "ChatUnifiedOptimizerCycle"
        WHERE "id" = promotion_row."cycleId";
      IF rollout_row."promotionReceiptId" IS NULL
         OR rollout_row."productKey" IS DISTINCT FROM product_key
         OR rollout_row."pointerRevision" IS DISTINCT FROM current_row."revision"
         OR rollout_row."cycleId" IS DISTINCT FROM promotion_row."cycleId"
         OR rollout_row."candidateId" IS DISTINCT FROM expected_candidate
         OR rollout_row."candidateDigest" IS DISTINCT FROM expected_candidate_digest
         OR rollout_row."bundleDigest" IS DISTINCT FROM expected_bundle_digest
         OR rollout_row."phase" <> 'active_100'
         OR rollout_row."phaseRevision" < 4
         OR rollout_row."activationAuditLogId" IS NULL
         OR cycle_state IS DISTINCT FROM 'succeeded'
         OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
           WHERE "cycleId" = promotion_row."cycleId") THEN RETURN NULL; END IF;
      RETURN promotion_row."id";
    END IF;
    SELECT * INTO rollback_row FROM "ChatUnifiedOptimizerRollbackReceipt"
      WHERE "requestId" = current_row."promotionRequestId";
    IF rollback_row."id" IS NULL
       OR rollback_row."productKey" IS DISTINCT FROM product_key
       OR rollback_row."toRevision" IS DISTINCT FROM current_row."revision"
       OR rollback_row."fromRevision" IS DISTINCT FROM current_row."revision" - 1
       OR rollback_row."targetRevision" IS DISTINCT FROM
         current_row."revision" - 2
       OR rollback_row."targetRevision" < 1
       OR rollback_row."targetKind" <> 'active_frozen_bundle'
       OR rollback_row."targetCandidateId" IS DISTINCT FROM expected_candidate
       OR rollback_row."targetDigest" IS DISTINCT FROM expected_bundle_digest
       OR rollback_row."auditLogId" IS DISTINCT FROM current_row."promotionAuditLogId"
       OR NOT current_row."runtimeAuthorized" THEN RETURN NULL; END IF;
    SELECT * INTO target_row FROM "ChatUnifiedOptimizerPointerSnapshot"
      WHERE "productKey" = product_key
        AND "revision" = rollback_row."targetRevision";
    IF target_row."productKey" IS NULL THEN RETURN NULL; END IF;
    current_row := target_row;
  END LOOP;
END;
$$;

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
        WHERE "id" = "chat_unified_optimizer_frozen_origin"(OLD."productKey", target_row."revision");
      SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
        WHERE "promotionReceiptId" = prior_row."id";
      SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
        WHERE "id" = prior_row."cycleId";
      SELECT "value" INTO stop_value FROM "AppSetting"
        WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
      IF prior_row."id" IS NULL

         OR prior_row."candidateId" <> target_row."candidateId"
         OR prior_row."candidateDigest" <> target_row."candidateDigest"
         OR prior_row."candidateBundleDigest" <> target_row."bundleDigest"
         OR prior_rollout."promotionReceiptId" IS NULL
         OR prior_rollout."productKey" <> OLD."productKey"
         OR prior_rollout."pointerRevision" <> prior_row."toRevision"
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
      WHERE "id" = "chat_unified_optimizer_frozen_origin"(OLD."productKey", OLD."revision");
    SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
      WHERE "promotionReceiptId" = prior_row."id";
    SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
      WHERE "id" = prior_row."cycleId";
    SELECT "value" INTO stop_value FROM "AppSetting"
      WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
    IF OLD."incumbentKind" <> 'active_frozen_bundle'
       OR prior_row."id" IS NULL

       OR prior_row."candidateId" <> OLD."candidateId"
       OR prior_row."candidateDigest" <> OLD."candidateDigest"
       OR prior_row."candidateBundleDigest" <> OLD."bundleDigest"
       OR prior_rollout."promotionReceiptId" IS NULL
       OR prior_rollout."productKey" <> OLD."productKey"
       OR prior_rollout."pointerRevision" <> prior_row."toRevision"
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

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_graduation_incumbent_ok"(
  product_key TEXT, pointer_revision INTEGER, promotion_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  prior_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  prior_rollout "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
  prior_cycle_state TEXT;
BEGIN
  SELECT * INTO receipt_row FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "id" = promotion_id AND "productKey" = product_key
      AND "toRevision" = pointer_revision;
  SELECT * INTO target_row FROM "ChatUnifiedOptimizerPointerSnapshot"
    WHERE "productKey" = product_key AND "revision" = pointer_revision - 1;
  IF receipt_row."id" IS NULL OR target_row."productKey" IS NULL
     OR receipt_row."fromRevision" <> target_row."revision"
     THEN
    RETURN false;
  END IF;
  IF pointer_revision = 1 THEN
    RETURN COALESCE(receipt_row."incumbentKind" = 'legacy_path'
      AND target_row."revision" = 0
      AND target_row."incumbentKind" = 'legacy_path'
      AND target_row."candidateId" IS NULL
      AND target_row."bundleDigest" IS NULL
      AND target_row."candidateDigest" = receipt_row."incumbentDigest",
      false);
  END IF;
  IF receipt_row."incumbentKind" <> 'active_frozen_bundle'
     OR target_row."incumbentKind" <> 'active_frozen_bundle'
     OR target_row."candidateId" IS NULL
     OR target_row."bundleDigest" IS NULL
     OR target_row."bundleDigest" <> receipt_row."incumbentDigest" THEN
    RETURN false;
  END IF;
  SELECT * INTO prior_row FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "id" = "chat_unified_optimizer_frozen_origin"(product_key, target_row."revision");
  SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
    WHERE "promotionReceiptId" = prior_row."id";
  SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = prior_row."cycleId";
  RETURN COALESCE(prior_row."id" IS NOT NULL
    AND prior_row."productKey" = product_key
    AND prior_row."toRevision" = prior_rollout."pointerRevision"
    AND prior_row."candidateId" = target_row."candidateId"
    AND prior_row."candidateDigest" = target_row."candidateDigest"
    AND prior_row."candidateBundleDigest" = target_row."bundleDigest"
    AND prior_rollout."promotionReceiptId" IS NOT NULL
    AND prior_rollout."productKey" = product_key
    AND prior_rollout."pointerRevision" = prior_row."toRevision"
    AND prior_rollout."cycleId" = prior_row."cycleId"
    AND prior_rollout."candidateId" = target_row."candidateId"
    AND prior_rollout."candidateDigest" = target_row."candidateDigest"
    AND prior_rollout."bundleDigest" = target_row."bundleDigest"
    AND prior_rollout."phase" = 'active_100'
    AND prior_rollout."phaseRevision" >= 4
    AND prior_rollout."activationAuditLogId" IS NOT NULL
    AND prior_cycle_state = 'succeeded'
    AND NOT EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
      WHERE "cycleId" = prior_row."cycleId"), false);
END;
$$;

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  recorded_row RECORD;
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
  IF pointer_row."productKey" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_binding_pointer_unavailable';
  END IF;
  IF rollback_row."id" IS NOT NULL THEN
    IF pointer_row."revision" = rollback_row."toRevision" THEN
      recorded_row := pointer_row;
    ELSE
      SELECT * INTO recorded_row FROM "ChatUnifiedOptimizerPointerSnapshot"
        WHERE "productKey" = rollback_row."productKey"
          AND "revision" = rollback_row."toRevision";
    END IF;
  ELSE
    IF pointer_row."revision" = receipt_row."toRevision" THEN
      recorded_row := pointer_row;
    ELSE
      SELECT * INTO recorded_row FROM "ChatUnifiedOptimizerPointerSnapshot"
        WHERE "productKey" = receipt_row."productKey"
          AND "revision" = receipt_row."toRevision";
    END IF;
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
    IF recorded_row."productKey" IS NULL OR target_row."productKey" IS NULL
       OR latch_row."cycleId" IS NULL OR NOT audit_ok
       OR recorded_row."revision" <> rollback_row."toRevision"
       OR recorded_row."promotionRequestId" <> rollback_row."requestId"
       OR recorded_row."promotionAuditLogId" <> rollback_row."auditLogId"
       OR (recorded_row."runtimeAuthorized" AND
         rollback_row."targetKind" <> 'active_frozen_bundle')
       OR recorded_row."candidateId" IS DISTINCT FROM
          target_row."candidateId"
       OR recorded_row."candidateDigest" <> target_row."candidateDigest"
       OR recorded_row."bundleDigest" IS DISTINCT FROM
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
  IF receipt_row."id" IS NULL OR recorded_row."productKey" IS NULL
     OR recorded_row."revision" <> receipt_row."toRevision"
     OR recorded_row."promotionRequestId" <> receipt_row."requestId"
     OR recorded_row."promotionAuditLogId" <> receipt_row."auditLogId"
     OR recorded_row."candidateId" <> receipt_row."candidateId"
     OR recorded_row."candidateDigest" <> receipt_row."candidateDigest"
     OR recorded_row."bundleDigest" <> receipt_row."candidateBundleDigest"
     OR recorded_row."sourceSha" <> receipt_row."sourceSha"
     OR recorded_row."baseSha" <> receipt_row."baseSha"
     OR recorded_row."schemaVersion" <> receipt_row."schemaVersion"
     OR recorded_row."schemaDigest" <> receipt_row."schemaDigest"
     OR recorded_row."promptVersion" <> receipt_row."promptVersion"
     OR recorded_row."controlsDigest" <> receipt_row."controlsDigest"
     OR recorded_row."policyVersion" <> receipt_row."policyVersion"
     OR recorded_row."protocolDigest" <> receipt_row."protocolDigest"
     OR recorded_row."authorizationExpiresAt" <>
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
