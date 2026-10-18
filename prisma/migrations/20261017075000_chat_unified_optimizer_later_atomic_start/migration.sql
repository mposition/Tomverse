-- A later candidate may replace an active-100 incumbent only if its prepared
-- pointer and 5% activation commit atomically. The active-bundle rollback
-- path remains closed until its exact serving binding is installed.
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
     OR NEW."runtimeAuthorized"
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
    IF failed_row."id" IS NULL OR target_row."productKey" IS NULL
       OR (OLD."runtimeAuthorized" AND
         (rollback_row."targetKind" <> 'legacy_path'
           OR rollout_row."promotionReceiptId" IS NULL
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

-- A later promotion cannot commit an inert replacement over the approved
-- incumbent. Prepared receipt, pointer revision and first canary phase must
-- all be present in the same transaction's final state.
CREATE FUNCTION "chat_unified_optimizer_later_atomic_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  rollout_row "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
BEGIN
  SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
    WHERE "productKey" = NEW."productKey";
  SELECT * INTO rollout_row FROM "ChatUnifiedOptimizerCanaryRollout"
    WHERE "promotionReceiptId" = NEW."id";
  IF pointer_row."productKey" IS NULL
     OR pointer_row."promotionRequestId" <> NEW."requestId"
     OR pointer_row."revision" <> NEW."toRevision"
     OR pointer_row."candidateId" <> NEW."candidateId"
     OR pointer_row."candidateDigest" <> NEW."candidateDigest"
     OR pointer_row."bundleDigest" <> NEW."candidateBundleDigest"
     OR NOT pointer_row."runtimeAuthorized"
     OR rollout_row."promotionReceiptId" IS NULL
     OR rollout_row."pointerRevision" <> NEW."toRevision"
     OR rollout_row."candidateId" <> NEW."candidateId"
     OR rollout_row."candidateDigest" <> NEW."candidateDigest"
     OR rollout_row."bundleDigest" <> NEW."candidateBundleDigest"
     OR rollout_row."phase" <> 'candidate_5'
     OR rollout_row."phaseRevision" <> 1
     OR rollout_row."activationAuditLogId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_later_atomic_start_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerLaterAtomic_commit_guard"
AFTER INSERT ON "ChatUnifiedOptimizerPromotionReceipt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."incumbentKind" = 'active_frozen_bundle')
EXECUTE FUNCTION "chat_unified_optimizer_later_atomic_commit_guard"();

-- The original completeness guard requires a prepared rollout at commit.
-- Keep that exact rule for the first legacy promotion; a later promotion is
-- complete only when its rollout has already started at 5% in this commit.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_canary_receipt_complete"()
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
      AND ((NEW."incumbentKind" = 'legacy_path'
        AND cr."phase" = 'prepared' AND cr."phaseRevision" = 0)
        OR (NEW."incumbentKind" = 'active_frozen_bundle'
          AND cr."phase" = 'candidate_5' AND cr."phaseRevision" = 1
          AND cr."activationAuditLogId" IS NOT NULL))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_receipt_incomplete';
  END IF;
  RETURN NULL;
END;
$$;
