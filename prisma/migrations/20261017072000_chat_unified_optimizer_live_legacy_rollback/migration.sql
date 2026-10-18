-- U28 allows a known signed failure in an already-live first candidate to
-- restore only the exact legacy incumbent snapshot. Later frozen-bundle
-- restoration remains closed until its serving binding is implemented.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_pointer_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  promotion_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  rollback_row "ChatUnifiedOptimizerRollbackReceipt"%ROWTYPE;
  rollout_row "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  failed_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
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
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_active_promotion_refused';
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
