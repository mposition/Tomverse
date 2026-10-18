-- U28 opens signed 90 -> 100 graduation only for the first candidate whose
-- immutable last-known-good incumbent is legacy. Later-candidate graduation
-- remains closed until frozen-bundle restoration is proven.
-- It does not start a rollout, change a pointer, or edit a policy gate.
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
           OR NEW."pointerRevision" <> 1
           OR receipt_row."incumbentKind" IS DISTINCT FROM 'legacy_path'
           OR receipt_row."fromRevision" <> 0
           OR target_row."incumbentKind" IS DISTINCT FROM 'legacy_path'
           OR target_row."revision" <> 0
           OR target_row."runtimeAuthorized"
           OR target_row."candidateId" IS NOT NULL
           OR target_row."bundleDigest" IS NOT NULL
           OR target_row."candidateDigest" <> receipt_row."incumbentDigest"))
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

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_canary_start_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  rollout_row "ChatUnifiedOptimizerCanaryRollout"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerActivePointer' THEN
    SELECT * INTO rollout_row FROM "ChatUnifiedOptimizerCanaryRollout"
      WHERE "productKey" = NEW."productKey"
        AND "pointerRevision" = NEW."revision";
    pointer_row := NEW;
  ELSE
    rollout_row := NEW;
    SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
      WHERE "productKey" = NEW."productKey";
  END IF;
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerCanaryRollout' THEN
    IF OLD."phase" <> 'prepared' THEN
      IF pointer_row."productKey" IS NULL
       OR NOT pointer_row."runtimeAuthorized"
       OR pointer_row."revision" <> rollout_row."pointerRevision"
       OR pointer_row."candidateId" <> rollout_row."candidateId"
       OR pointer_row."candidateDigest" <> rollout_row."candidateDigest"
       OR pointer_row."bundleDigest" <> rollout_row."bundleDigest"
       OR rollout_row."phaseRevision" <> OLD."phaseRevision" + 1
       OR rollout_row."activationAuditLogId" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'chat_unified_optimizer_canary_advance_incomplete';
      END IF;
      RETURN NULL;
    END IF;
  END IF;
  IF pointer_row."productKey" IS NULL
     OR rollout_row."promotionReceiptId" IS NULL
     OR NOT pointer_row."runtimeAuthorized"
     OR pointer_row."revision" <> rollout_row."pointerRevision"
     OR pointer_row."candidateId" <> rollout_row."candidateId"
     OR pointer_row."candidateDigest" <> rollout_row."candidateDigest"
     OR pointer_row."bundleDigest" <> rollout_row."bundleDigest"
     OR rollout_row."phase" <> 'candidate_5'
     OR rollout_row."phaseRevision" <> 1
     OR rollout_row."activationAuditLogId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_canary_start_incomplete';
  END IF;
  RETURN NULL;
END;
$$;
