-- U28 initial 5% canary transition. No row is activated by this migration.
-- Existing promotion and rollback commits retain their revision guards.
ALTER TABLE "ChatUnifiedOptimizerActivePointer"
  DROP CONSTRAINT "ChatUnifiedOptimizerActivePointer_closed_check";
ALTER TABLE "ChatUnifiedOptimizerActivePointer"
  ADD CONSTRAINT "ChatUnifiedOptimizerActivePointer_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "revision" >= 0
    AND "incumbentKind" IN ('legacy_path', 'active_frozen_bundle')
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND ("bundleDigest" IS NULL OR "bundleDigest" ~ '^[0-9a-f]{64}$')
    AND "sourceSha" ~ '^[0-9a-f]{40}$'
    AND "baseSha" ~ '^[0-9a-f]{40}$'
    AND "schemaVersion" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "schemaDigest" ~ '^[0-9a-f]{64}$'
    AND "promptVersion" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "controlsDigest" ~ '^[0-9a-f]{64}$'
    AND "policyVersion" = 1
    AND "protocolDigest" ~ '^[0-9a-f]{64}$'
    AND (NOT "runtimeAuthorized" OR "incumbentKind" = 'active_frozen_bundle')
    AND (("incumbentKind" = 'legacy_path' AND "candidateId" IS NULL
      AND "bundleDigest" IS NULL)
      OR ("incumbentKind" = 'active_frozen_bundle'
        AND "candidateId" IS NOT NULL AND "bundleDigest" IS NOT NULL))
  );

-- The snapshot records the immutable identity of a new revision. Switching
-- the same revision from prepared to live must not overwrite that identity.
DROP TRIGGER "ChatUnifiedOptimizerActivePointer_snapshot"
  ON "ChatUnifiedOptimizerActivePointer";
CREATE TRIGGER "ChatUnifiedOptimizerActivePointer_snapshot_insert"
AFTER INSERT ON "ChatUnifiedOptimizerActivePointer"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_snapshot_pointer"();
CREATE TRIGGER "ChatUnifiedOptimizerActivePointer_snapshot_revision"
AFTER UPDATE ON "ChatUnifiedOptimizerActivePointer"
FOR EACH ROW WHEN (NEW."revision" IS DISTINCT FROM OLD."revision")
EXECUTE FUNCTION "chat_unified_optimizer_snapshot_pointer"();

-- The historical deferred guard checks the short promotion-signature write
-- deadline. A later same-revision activation has its own final-state guard.
DROP TRIGGER "ChatUnifiedOptimizerActivePointer_commit_guard"
  ON "ChatUnifiedOptimizerActivePointer";
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerActivePointer_insert_commit_guard"
AFTER INSERT ON "ChatUnifiedOptimizerActivePointer"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_promotion_commit_guard"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerActivePointer_revision_commit_guard"
AFTER UPDATE ON "ChatUnifiedOptimizerActivePointer"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."revision" IS DISTINCT FROM OLD."revision")
EXECUTE FUNCTION "chat_unified_optimizer_promotion_commit_guard"();

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
     OR NEW."runtimeAuthorized" OR OLD."runtimeAuthorized"
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
    IF failed_row."id" IS NULL OR target_row."productKey" IS NULL
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

DROP TRIGGER "chat_unified_optimizer_canary_rollout_guard_trigger"
  ON "ChatUnifiedOptimizerCanaryRollout";
CREATE TRIGGER "chat_unified_optimizer_canary_rollout_insert_delete_guard"
BEFORE INSERT OR DELETE ON "ChatUnifiedOptimizerCanaryRollout"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_canary_rollout_guard"();

CREATE FUNCTION "chat_unified_optimizer_canary_start_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  owner_audit "AdminAuditLog"%ROWTYPE;
  phase_audit "AdminAuditLog"%ROWTYPE;
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
  SELECT "value" INTO release_setting FROM "AppSetting"
    WHERE "key" = 'feature.chatUnifiedRouterRefinerRelease';
  SELECT "state" INTO cycle_state FROM "ChatUnifiedOptimizerCycle"
    WHERE "id" = NEW."cycleId";
  SELECT "value" INTO stop_value FROM "AppSetting"
    WHERE "key" = 'chat.unified_optimizer.stop_latch.v1';
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
CREATE TRIGGER "chat_unified_optimizer_canary_start_guard_trigger"
BEFORE UPDATE ON "ChatUnifiedOptimizerCanaryRollout"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_canary_start_guard"();

-- Both rows must commit together. A partial phase or pointer write is rejected.
CREATE FUNCTION "chat_unified_optimizer_canary_start_commit_guard"()
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
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerCanaryRollout_start_commit_guard"
AFTER UPDATE ON "ChatUnifiedOptimizerCanaryRollout"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_canary_start_commit_guard"();
CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerActivePointer_start_commit_guard"
AFTER UPDATE ON "ChatUnifiedOptimizerActivePointer"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."revision" = NEW."revision" AND
  OLD."runtimeAuthorized" IS DISTINCT FROM NEW."runtimeAuthorized")
EXECUTE FUNCTION "chat_unified_optimizer_canary_start_commit_guard"();
