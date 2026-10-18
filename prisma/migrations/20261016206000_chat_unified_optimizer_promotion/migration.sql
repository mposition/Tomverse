-- U27 prepares a content-free candidate pointer. Product runtime remains off;
-- first activation and serving are separate U35 decisions.
CREATE TABLE "ChatUnifiedOptimizerActivePointer" (
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
  "runtimeAuthorized" BOOLEAN NOT NULL DEFAULT false,
  "promotionRequestId" UUID NOT NULL,
  "promotionAuditLogId" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerActivePointer_pkey" PRIMARY KEY ("productKey"),
  CONSTRAINT "ChatUnifiedOptimizerActivePointer_closed_check" CHECK (
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
    AND "runtimeAuthorized" = false
    AND (("incumbentKind" = 'legacy_path' AND "candidateId" IS NULL AND "bundleDigest" IS NULL)
      OR ("incumbentKind" = 'active_frozen_bundle' AND "candidateId" IS NOT NULL AND "bundleDigest" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "ChatUnifiedOptimizerActivePointer_candidateId_key"
  ON "ChatUnifiedOptimizerActivePointer"("candidateId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerActivePointer_promotionRequestId_key"
  ON "ChatUnifiedOptimizerActivePointer"("promotionRequestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerActivePointer_promotionAuditLogId_key"
  ON "ChatUnifiedOptimizerActivePointer"("promotionAuditLogId");

CREATE TABLE "ChatUnifiedOptimizerPromotionReceipt" (
  "id" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "productKey" TEXT NOT NULL,
  "fromRevision" INTEGER NOT NULL,
  "toRevision" INTEGER NOT NULL,
  "incumbentKind" TEXT NOT NULL,
  "incumbentDigest" TEXT NOT NULL,
  "candidateId" UUID NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "candidateBundleDigest" TEXT NOT NULL,
  "cycleId" UUID NOT NULL,
  "sourceSha" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "schemaDigest" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "controlsDigest" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "promotionMode" TEXT NOT NULL,
  "protocolDigest" TEXT NOT NULL,
  "calibrationLabelSetDigest" TEXT NOT NULL,
  "judgePanelDigest" TEXT NOT NULL,
  "priceSetDigest" TEXT NOT NULL,
  "modelPoolDigest" TEXT NOT NULL,
  "strataDigest" TEXT NOT NULL,
  "metricsDigest" TEXT NOT NULL,
  "routerEvidenceDigest" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "evidencePayloadDigest" TEXT NOT NULL,
  "signerKeyId" TEXT NOT NULL,
  "signedPayloadDigest" TEXT NOT NULL,
  "signatureDigest" TEXT NOT NULL,
  "prerequisiteBindingDigest" TEXT NOT NULL,
  "comparisonRunBindingDigest" TEXT NOT NULL,
  "authorizationExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "runtimeAuthorized" BOOLEAN NOT NULL DEFAULT false,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerPromotionReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatUnifiedOptimizerPromotionReceipt_closed_check" CHECK (
    "productKey" = 'internal-chat-optimization'
    AND "fromRevision" >= 0 AND "toRevision" = "fromRevision" + 1
    AND "incumbentKind" IN ('legacy_path', 'active_frozen_bundle')
    AND "requestDigest" ~ '^[0-9a-f]{64}$'
    AND "incumbentDigest" ~ '^[0-9a-f]{64}$'
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND "candidateBundleDigest" ~ '^[0-9a-f]{64}$'
    AND "sourceSha" ~ '^[0-9a-f]{40}$' AND "baseSha" ~ '^[0-9a-f]{40}$'
    AND "schemaVersion" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "schemaDigest" ~ '^[0-9a-f]{64}$'
    AND "promptVersion" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "controlsDigest" ~ '^[0-9a-f]{64}$'
    AND "policyVersion" = 1
    AND "promotionMode" IN ('quality_superiority', 'quality_noninferior_cost_10pct')
    AND "protocolDigest" ~ '^[0-9a-f]{64}$'
    AND "calibrationLabelSetDigest" ~ '^[0-9a-f]{64}$'
    AND "judgePanelDigest" ~ '^[0-9a-f]{64}$'
    AND "priceSetDigest" ~ '^[0-9a-f]{64}$'
    AND "modelPoolDigest" ~ '^[0-9a-f]{64}$'
    AND "strataDigest" ~ '^[0-9a-f]{64}$'
    AND "metricsDigest" ~ '^[0-9a-f]{64}$'
    AND "routerEvidenceDigest" ~ '^[0-9a-f]{64}$'
    AND "evidenceRef" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "signerKeyId" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    AND "evidencePayloadDigest" ~ '^[0-9a-f]{64}$'
    AND "signedPayloadDigest" ~ '^[0-9a-f]{64}$'
    AND "signatureDigest" ~ '^[0-9a-f]{64}$'
    AND "prerequisiteBindingDigest" ~ '^[0-9a-f]{64}$'
    AND "comparisonRunBindingDigest" ~ '^[0-9a-f]{64}$'
    AND "runtimeAuthorized" = false
  )
);

CREATE UNIQUE INDEX "ChatUnifiedOptimizerPromotionReceipt_requestId_key"
  ON "ChatUnifiedOptimizerPromotionReceipt"("requestId");
CREATE UNIQUE INDEX "ChatUnifiedOptimizerPromotionReceipt_auditLogId_key"
  ON "ChatUnifiedOptimizerPromotionReceipt"("auditLogId");
CREATE INDEX "ChatUnifiedOptimizerPromotionReceipt_candidateId_createdAt_idx"
  ON "ChatUnifiedOptimizerPromotionReceipt"("candidateId", "createdAt");
CREATE INDEX "ChatUnifiedOptimizerPromotionReceipt_productKey_toRevision_idx"
  ON "ChatUnifiedOptimizerPromotionReceipt"("productKey", "toRevision");

ALTER TABLE "ChatUnifiedOptimizerActivePointer"
  ADD CONSTRAINT "ChatUnifiedOptimizerActivePointer_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerActivePointer_promotionAuditLogId_fkey"
  FOREIGN KEY ("promotionAuditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ChatUnifiedOptimizerPromotionReceipt"
  ADD CONSTRAINT "ChatUnifiedOptimizerPromotionReceipt_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerPromotionReceipt_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_receipt_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'chat_unified_optimizer_promotion_receipt_immutable';
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerPromotionReceipt_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerPromotionReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_promotion_receipt_immutable"();

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_pointer_transition_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition_receipt "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
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
     OR NEW."incumbentKind" <> 'active_frozen_bundle'
     OR NEW."candidateId" IS NULL OR NEW."bundleDigest" IS NULL
     OR NEW."runtimeAuthorized" OR OLD."runtimeAuthorized"
     OR NEW."promotionRequestId" = OLD."promotionRequestId"
     OR NEW."promotionAuditLogId" = OLD."promotionAuditLogId" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_transition_refused';
  END IF;
  SELECT * INTO transition_receipt
    FROM "ChatUnifiedOptimizerPromotionReceipt"
    WHERE "requestId" = NEW."promotionRequestId";
  IF transition_receipt."id" IS NULL
     OR transition_receipt."productKey" <> OLD."productKey"
     OR transition_receipt."fromRevision" <> OLD."revision"
     OR transition_receipt."toRevision" <> NEW."revision"
     OR transition_receipt."incumbentKind" <> OLD."incumbentKind"
     OR transition_receipt."incumbentDigest" <>
       (CASE WHEN OLD."incumbentKind" = 'legacy_path'
         THEN OLD."candidateDigest" ELSE OLD."bundleDigest" END) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'chat_unified_optimizer_pointer_incumbent_refused';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerActivePointer_transition_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ChatUnifiedOptimizerActivePointer"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_pointer_transition_guard"();

CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_commit_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  receipt_row "ChatUnifiedOptimizerPromotionReceipt"%ROWTYPE;
  candidate_row "ChatUnifiedOptimizerCandidate"%ROWTYPE;
  audit_ok BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerActivePointer' AND NEW."revision" = 0 THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'ChatUnifiedOptimizerPromotionReceipt' THEN
    receipt_row := NEW;
    SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
      WHERE "productKey" = NEW."productKey";
  ELSE
    pointer_row := NEW;
    SELECT * INTO receipt_row FROM "ChatUnifiedOptimizerPromotionReceipt"
      WHERE "requestId" = NEW."promotionRequestId";
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

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerActivePointer_commit_guard"
AFTER INSERT OR UPDATE ON "ChatUnifiedOptimizerActivePointer"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_promotion_commit_guard"();

CREATE CONSTRAINT TRIGGER "ChatUnifiedOptimizerPromotionReceipt_commit_guard"
AFTER INSERT ON "ChatUnifiedOptimizerPromotionReceipt"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "chat_unified_optimizer_promotion_commit_guard"();
