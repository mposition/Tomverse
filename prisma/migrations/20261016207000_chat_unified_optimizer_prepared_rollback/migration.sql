-- U28 stores every pointer revision before allowing a rollback. This migration
-- grants no product-runtime authority and never touches the global Chat switch.
CREATE TABLE "ChatUnifiedOptimizerPointerSnapshot" (
  "productKey" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "incumbentKind" TEXT NOT NULL,
  "candidateId" UUID,
  "candidateDigest" TEXT NOT NULL,
  "bundleDigest" TEXT,
  "sourceSha" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "schemaDigest" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "controlsDigest" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "protocolDigest" TEXT NOT NULL,
  "authorizationExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "runtimeAuthorized" BOOLEAN NOT NULL,
  "promotionRequestId" UUID NOT NULL,
  "promotionAuditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerPointerSnapshot_pkey"
    PRIMARY KEY ("productKey", "revision"),
  CONSTRAINT "ChatUnifiedOptimizerPointerSnapshot_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "revision" >= 0
    AND "incumbentKind" IN ('legacy_path', 'active_frozen_bundle')
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND ("bundleDigest" IS NULL OR "bundleDigest" ~ '^[0-9a-f]{64}$')
    AND NOT "runtimeAuthorized"
    AND (("incumbentKind" = 'legacy_path' AND "candidateId" IS NULL
      AND "bundleDigest" IS NULL)
      OR ("incumbentKind" = 'active_frozen_bundle'
      AND "candidateId" IS NOT NULL AND "bundleDigest" IS NOT NULL))
  )
);

CREATE TABLE "ChatUnifiedOptimizerRollbackReceipt" (
  "id" UUID NOT NULL PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "requestDigest" TEXT NOT NULL,
  "productKey" TEXT NOT NULL,
  "fromRevision" INTEGER NOT NULL,
  "toRevision" INTEGER NOT NULL,
  "targetRevision" INTEGER NOT NULL,
  "failedCandidateId" UUID NOT NULL,
  "failedCycleId" UUID NOT NULL,
  "failedPromotionId" UUID NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetCandidateId" UUID,
  "targetDigest" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "signerKeyId" TEXT NOT NULL,
  "signedPayloadDigest" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerRollbackReceipt_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "fromRevision" > 0 AND "toRevision" = "fromRevision" + 1
    AND "targetRevision" = "fromRevision" - 1
    AND "targetKind" IN ('legacy_path', 'active_frozen_bundle')
    AND ("requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("targetDigest" ~ '^[0-9a-f]{64}$')
    AND ("evidenceDigest" ~ '^[0-9a-f]{64}$')
    AND ("signedPayloadDigest" ~ '^[0-9a-f]{64}$')
    AND ("signerKeyId" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$')
    AND (("targetKind" = 'legacy_path' AND "targetCandidateId" IS NULL)
      OR ("targetKind" = 'active_frozen_bundle'
        AND "targetCandidateId" IS NOT NULL))
  )
);

CREATE TABLE "ChatUnifiedOptimizerCycleLatch" (
  "cycleId" UUID NOT NULL PRIMARY KEY,
  "rollbackId" UUID NOT NULL UNIQUE,
  "auditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "ChatUnifiedOptimizerRollbackReceipt"
  ADD CONSTRAINT "ChatUnifiedOptimizerRollbackReceipt_failedCandidateId_fkey"
    FOREIGN KEY ("failedCandidateId") REFERENCES
      "ChatUnifiedOptimizerCandidate"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerRollbackReceipt_failedPromotionId_fkey"
    FOREIGN KEY ("failedPromotionId") REFERENCES
      "ChatUnifiedOptimizerPromotionReceipt"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerRollbackReceipt_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerRollbackReceipt_targetSnapshot_fkey"
    FOREIGN KEY ("productKey", "targetRevision") REFERENCES
      "ChatUnifiedOptimizerPointerSnapshot"("productKey", "revision")
      ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ChatUnifiedOptimizerCycleLatch"
  ADD CONSTRAINT "ChatUnifiedOptimizerCycleLatch_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerCycleLatch_rollbackId_fkey"
    FOREIGN KEY ("rollbackId") REFERENCES
      "ChatUnifiedOptimizerRollbackReceipt"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerCycleLatch_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "chat_unified_optimizer_snapshot_insert_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM "ChatUnifiedOptimizerActivePointer"
    WHERE "productKey" = NEW."productKey";
  IF current_row."productKey" IS NULL
     OR current_row."revision" <> NEW."revision"
     OR ROW(current_row."incumbentKind", current_row."candidateId",
       current_row."candidateDigest", current_row."bundleDigest",
       current_row."sourceSha", current_row."baseSha",
       current_row."schemaVersion", current_row."schemaDigest",
       current_row."promptVersion", current_row."controlsDigest",
       current_row."policyVersion", current_row."protocolDigest",
       current_row."authorizationExpiresAt",
       current_row."runtimeAuthorized",
       current_row."promotionRequestId",
       current_row."promotionAuditLogId")
       IS DISTINCT FROM
       ROW(NEW."incumbentKind", NEW."candidateId",
         NEW."candidateDigest", NEW."bundleDigest",
         NEW."sourceSha", NEW."baseSha", NEW."schemaVersion",
         NEW."schemaDigest", NEW."promptVersion",
         NEW."controlsDigest", NEW."policyVersion",
         NEW."protocolDigest", NEW."authorizationExpiresAt",
         NEW."runtimeAuthorized", NEW."promotionRequestId",
         NEW."promotionAuditLogId") THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_snapshot_insert_refused';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerPointerSnapshot_insert_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerPointerSnapshot"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_snapshot_insert_guard"();

CREATE TRIGGER "ChatUnifiedOptimizerPointerSnapshot_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerPointerSnapshot"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerPointerSnapshot_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerPointerSnapshot"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerRollbackReceipt_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerRollbackReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerRollbackReceipt_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerRollbackReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCycleLatch_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerCycleLatch"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCycleLatch_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCycleLatch"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();

CREATE FUNCTION "chat_unified_optimizer_snapshot_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ChatUnifiedOptimizerPointerSnapshot" (
    "productKey", "revision", "incumbentKind", "candidateId",
    "candidateDigest", "bundleDigest", "sourceSha", "baseSha",
    "schemaVersion", "schemaDigest", "promptVersion", "controlsDigest",
    "policyVersion", "protocolDigest", "authorizationExpiresAt",
    "runtimeAuthorized", "promotionRequestId", "promotionAuditLogId")
  VALUES (NEW."productKey", NEW."revision", NEW."incumbentKind",
    NEW."candidateId", NEW."candidateDigest", NEW."bundleDigest",
    NEW."sourceSha", NEW."baseSha", NEW."schemaVersion",
    NEW."schemaDigest", NEW."promptVersion", NEW."controlsDigest",
    NEW."policyVersion", NEW."protocolDigest",
    NEW."authorizationExpiresAt", NEW."runtimeAuthorized",
    NEW."promotionRequestId", NEW."promotionAuditLogId");
  RETURN NULL;
END;
$$;
CREATE TRIGGER "ChatUnifiedOptimizerActivePointer_snapshot"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerActivePointer"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_snapshot_pointer"();

-- Existing installations retain only their current state. If an earlier
-- revision is missing, rollback refuses instead of guessing its metadata.
INSERT INTO "ChatUnifiedOptimizerPointerSnapshot" (
  "productKey", "revision", "incumbentKind", "candidateId",
  "candidateDigest", "bundleDigest", "sourceSha", "baseSha",
  "schemaVersion", "schemaDigest", "promptVersion", "controlsDigest",
  "policyVersion", "protocolDigest", "authorizationExpiresAt",
  "runtimeAuthorized", "promotionRequestId", "promotionAuditLogId")
SELECT "productKey", "revision", "incumbentKind", "candidateId",
  "candidateDigest", "bundleDigest", "sourceSha", "baseSha",
  "schemaVersion", "schemaDigest", "promptVersion", "controlsDigest",
  "policyVersion", "protocolDigest", "authorizationExpiresAt",
  "runtimeAuthorized", "promotionRequestId", "promotionAuditLogId"
FROM "ChatUnifiedOptimizerActivePointer";

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_pointer_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  promotion_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  rollback_row "ChatUnifiedOptimizerRollbackReceipt"%ROWTYPE;
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

-- The old deferred guard still protects promotions. For rollback it checks
-- the pointer, immutable target, two audit records and cycle latch together.
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
       OR pointer_row."runtimeAuthorized"
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

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerRollbackReceipt_commit_guard"
AFTER INSERT ON "ChatUnifiedOptimizerRollbackReceipt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_promotion_commit_guard"();
