-- Later graduation requires a proved active-100 frozen incumbent.
CREATE FUNCTION "chat_unified_optimizer_graduation_incumbent_ok"(
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
     OR target_row."runtimeAuthorized" THEN
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
    WHERE "requestId" = target_row."promotionRequestId";
  SELECT * INTO prior_rollout FROM "ChatUnifiedOptimizerCanaryRollout"
    WHERE "promotionReceiptId" = prior_row."id";
  SELECT "state" INTO prior_cycle_state FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = prior_row."cycleId";
  RETURN COALESCE(prior_row."id" IS NOT NULL
    AND prior_row."productKey" = product_key
    AND prior_row."toRevision" = target_row."revision"
    AND prior_row."candidateId" = target_row."candidateId"
    AND prior_row."candidateDigest" = target_row."candidateDigest"
    AND prior_row."candidateBundleDigest" = target_row."bundleDigest"
    AND prior_rollout."promotionReceiptId" IS NOT NULL
    AND prior_rollout."productKey" = product_key
    AND prior_rollout."pointerRevision" = target_row."revision"
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
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_canary_start_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  owner_audit "AdminAuditLog"%ROWTYPE;
  phase_audit "AdminAuditLog"%ROWTYPE;
  target_row "ChatUnifiedOptimizerPointerSnapshot"%ROWTYPE;
  release_setting TEXT;
  cycle_state TEXT;
  stop_value TEXT;
BEGIN
  SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
    WHERE "productKey" = NEW."productKey";
  SELECT * INTO receipt_row FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "id" = NEW."promotionReceiptId";
  SELECT * INTO owner_audit FROM "AdminAuditLog"
    WHERE "id" = NEW."activationAuditLogId";
  SELECT * INTO phase_audit FROM "AdminAuditLog"
    WHERE "id" = NEW."lastAuditLogId";
  SELECT * INTO target_row FROM "ChatUnifiedOptimizerPointerSnapshot"
    WHERE "productKey" = NEW."productKey"
      AND "revision" = NEW."pointerRevision" - 1;
  SELECT "value" INTO release_setting FROM "AppSetting"
    WHERE "key" = 'feature.chatUnifiedRouterRefinerRelease';
  SELECT "state" INTO cycle_state FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = NEW."cycleId";
  SELECT "value" INTO stop_value FROM "AppSetting"
    WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
  -- The promotion signature's expiry limits the one-time prepared pointer
  -- write. A multi-day canary advances under the current owner release,
  -- pointer/phase CAS and fresh signed observation instead.
  IF OLD."phase" <> 'prepared' THEN
    IF OLD."phase" NOT IN ('candidate_5', 'candidate_25', 'candidate_90')
       OR NOT ((OLD."phase" = 'candidate_5' AND NEW."phase" = 'candidate_25')
         OR (OLD."phase" = 'candidate_25' AND NEW."phase" = 'candidate_90')
         OR (OLD."phase" = 'candidate_90' AND NEW."phase" = 'active_100'))
       OR NEW."phaseRevision" <> OLD."phaseRevision" + 1
       OR NEW."phaseStartedAt" IS NULL
       OR NEW."phaseStartedAt" < OLD."phaseStartedAt" + interval '24 hours'
       OR NEW."phaseStartedAt" > clock_timestamp() + interval '1 second'
       OR (NEW."phase" = 'active_100' AND
         (NEW."phaseStartedAt" < OLD."canaryStartedAt" + interval '7 days'
           OR NOT "chat_unified_optimizer_graduation_incumbent_ok"(
             NEW."productKey", NEW."pointerRevision",
             NEW."promotionReceiptId")))
       OR NEW."canaryStartedAt" IS DISTINCT FROM OLD."canaryStartedAt"
       OR NEW."activationAuditLogId" IS DISTINCT FROM
         OLD."activationAuditLogId"
       OR NEW."lastAuditLogId" = OLD."lastAuditLogId"
       OR ROW(NEW."promotionReceiptId", NEW."productKey",
         NEW."pointerRevision", NEW."cycleId", NEW."candidateId",
         NEW."candidateDigest", NEW."bundleDigest", NEW."assignmentSalt",
         NEW."createdAt") IS DISTINCT FROM
         ROW(OLD."promotionReceiptId", OLD."productKey",
           OLD."pointerRevision", OLD."cycleId", OLD."candidateId",
           OLD."candidateDigest", OLD."bundleDigest", OLD."assignmentSalt",
           OLD."createdAt")
       OR pointer_row."productKey" IS NULL OR NOT pointer_row."runtimeAuthorized"
       OR pointer_row."revision" <> NEW."pointerRevision"
       OR pointer_row."candidateId" <> NEW."candidateId"
       OR pointer_row."candidateDigest" <> NEW."candidateDigest"
       OR pointer_row."bundleDigest" <> NEW."bundleDigest"
       OR receipt_row."id" IS NULL
       OR receipt_row."requestId" <> pointer_row."promotionRequestId"
       OR receipt_row."cycleId" <> NEW."cycleId"
       OR receipt_row."candidateId" <> NEW."candidateId"
       OR receipt_row."candidateDigest" <> NEW."candidateDigest"
       OR receipt_row."candidateBundleDigest" <> NEW."bundleDigest"
       OR receipt_row."toRevision" <> NEW."pointerRevision"
       OR receipt_row."runtimeAuthorized"
       OR cycle_state IS DISTINCT FROM 'succeeded'
       OR stop_value IS NOT NULL
       OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
         WHERE "cycleId" = NEW."cycleId")
       OR owner_audit."id" IS NULL OR owner_audit."actorUserId" IS NULL
       OR owner_audit."entryHash" IS NULL
       OR owner_audit."action" <> 'chat.unified_runtime.initial_activated'
       OR owner_audit."targetType" <> 'ChatUnifiedRouterRefinerRelease'
       OR release_setting IS NULL
       OR release_setting::jsonb->>'activationAuditLogId' IS DISTINCT FROM
         NEW."activationAuditLogId"
       OR release_setting::jsonb->>'releaseBindingDigest' IS DISTINCT FROM
         owner_audit."targetId"
       OR release_setting::jsonb->>'status' IS DISTINCT FROM 'active'
       OR phase_audit."id" IS NULL OR phase_audit."actorUserId" IS NOT NULL
       OR phase_audit."entryHash" IS NULL
       OR phase_audit."action" <> 'chat.unified_optimizer.canary_phase_advanced'
       OR phase_audit."targetType" <> 'ChatUnifiedOptimizerCanaryRollout'
       OR phase_audit."targetId" <> NEW."promotionReceiptId"::text
       OR phase_audit."metadata"->>'systemActor' IS DISTINCT FROM
         'chat-unified-candidate-promoter'
       OR phase_audit."metadata"->>'promotionReceiptId' IS DISTINCT FROM
         NEW."promotionReceiptId"::text
       OR phase_audit."metadata"->>'pointerRevision' IS DISTINCT FROM
         NEW."pointerRevision"::text
       OR phase_audit."metadata"->>'candidateId' IS DISTINCT FROM
         NEW."candidateId"::text
       OR phase_audit."metadata"->>'candidateDigest' IS DISTINCT FROM
         NEW."candidateDigest"
       OR phase_audit."metadata"->>'fromPhase' IS DISTINCT FROM OLD."phase"
       OR phase_audit."metadata"->>'toPhase' IS DISTINCT FROM NEW."phase"
       OR phase_audit."metadata"->>'fromPhaseRevision' IS DISTINCT FROM
         OLD."phaseRevision"::text
       OR phase_audit."metadata"->>'toPhaseRevision' IS DISTINCT FROM
         NEW."phaseRevision"::text
       OR phase_audit."metadata"->>'activationAuditLogId' IS DISTINCT FROM
         NEW."activationAuditLogId"
       OR phase_audit."metadata"->>'evidenceDigest' IS NULL
       OR phase_audit."metadata"->>'signedPayloadDigest' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'chat_unified_optimizer_canary_advance_refused';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."phase" <> 'prepared' OR OLD."phaseRevision" <> 0
     OR NEW."phase" <> 'candidate_5' OR NEW."phaseRevision" <> 1
     OR NEW."canaryStartedAt" IS NULL
     OR NEW."phaseStartedAt" IS DISTINCT FROM NEW."canaryStartedAt"
     OR NEW."canaryStartedAt" < OLD."createdAt"
     OR NEW."canaryStartedAt" > clock_timestamp() + interval '1 second'
     OR NEW."activationAuditLogId" IS NULL
     OR NEW."lastAuditLogId" = OLD."lastAuditLogId"
     OR ROW(NEW."promotionReceiptId", NEW."productKey",
       NEW."pointerRevision", NEW."cycleId", NEW."candidateId",
       NEW."candidateDigest", NEW."bundleDigest", NEW."assignmentSalt",
       NEW."createdAt") IS DISTINCT FROM
       ROW(OLD."promotionReceiptId", OLD."productKey",
         OLD."pointerRevision", OLD."cycleId", OLD."candidateId",
         OLD."candidateDigest", OLD."bundleDigest", OLD."assignmentSalt",
         OLD."createdAt")
     OR pointer_row."productKey" IS NULL OR pointer_row."runtimeAuthorized"
     OR pointer_row."revision" <> NEW."pointerRevision"
     OR pointer_row."candidateId" <> NEW."candidateId"
     OR pointer_row."candidateDigest" <> NEW."candidateDigest"
     OR pointer_row."bundleDigest" <> NEW."bundleDigest"
     OR receipt_row."id" IS NULL
     OR receipt_row."requestId" <> pointer_row."promotionRequestId"
     OR receipt_row."cycleId" <> NEW."cycleId"
     OR receipt_row."runtimeAuthorized"
     OR receipt_row."candidateId" <> NEW."candidateId"
     OR receipt_row."candidateDigest" <> NEW."candidateDigest"
     OR receipt_row."candidateBundleDigest" <> NEW."bundleDigest"
     OR receipt_row."toRevision" <> NEW."pointerRevision"
     OR receipt_row."authorizationExpiresAt" <= clock_timestamp()
     OR cycle_state IS DISTINCT FROM 'succeeded'
     OR stop_value IS NOT NULL
     OR EXISTS (SELECT 1 FROM "ChatUnifiedOptimizerCycleLatch"
       WHERE "cycleId" = NEW."cycleId")
     OR owner_audit."id" IS NULL OR owner_audit."actorUserId" IS NULL
     OR owner_audit."entryHash" IS NULL
     OR owner_audit."action" <> 'chat.unified_runtime.initial_activated'
     OR owner_audit."targetType" <> 'ChatUnifiedRouterRefinerRelease'
     OR release_setting::jsonb->>'releaseBindingDigest' IS DISTINCT FROM
       owner_audit."targetId"
     OR release_setting IS NULL
     OR release_setting::jsonb->>'activationAuditLogId' IS DISTINCT FROM
       NEW."activationAuditLogId"
     OR release_setting::jsonb->>'status' IS DISTINCT FROM 'active'
     OR phase_audit."id" IS NULL OR phase_audit."actorUserId" IS NOT NULL
     OR phase_audit."entryHash" IS NULL
     OR phase_audit."action" <> 'chat.unified_optimizer.canary_started'
     OR phase_audit."targetType" <> 'ChatUnifiedOptimizerCanaryRollout'
     OR phase_audit."targetId" <> NEW."promotionReceiptId"::text
     OR phase_audit."metadata"->>'systemActor' IS DISTINCT FROM
       'chat-unified-candidate-promoter'
     OR phase_audit."metadata"->>'promotionReceiptId' IS DISTINCT FROM
       NEW."promotionReceiptId"::text
     OR phase_audit."metadata"->>'pointerRevision' IS DISTINCT FROM
       NEW."pointerRevision"::text
     OR phase_audit."metadata"->>'candidateId' IS DISTINCT FROM
       NEW."candidateId"::text
     OR phase_audit."metadata"->>'candidateDigest' IS DISTINCT FROM
       NEW."candidateDigest"
     OR phase_audit."metadata"->>'phase' IS DISTINCT FROM 'candidate_5'
     OR phase_audit."metadata"->>'phaseRevision' IS DISTINCT FROM '1'
     OR phase_audit."metadata"->>'activationAuditLogId' IS DISTINCT FROM
       NEW."activationAuditLogId" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_start_refused';
  END IF;
  RETURN NEW;
END;
$$;
