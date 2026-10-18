-- Only a hash-chained system-audited, due, unreferenced candidate body may be
-- removed. The metadata identity and deletion receipt remain immutable.
CREATE TABLE "ChatUnifiedOptimizerCandidateRetentionHold" (
  "candidateId" UUID NOT NULL PRIMARY KEY,
  "heldAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMPTZ(3),
  "holdAuditLogId" TEXT NOT NULL UNIQUE,
  "releaseAuditLogId" TEXT UNIQUE,
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionHold_consistent" CHECK (
    ("releasedAt" IS NULL AND "releaseAuditLogId" IS NULL) OR
    ("releasedAt" IS NOT NULL AND "releaseAuditLogId" IS NOT NULL
      AND "releasedAt" >= "heldAt")
  ),
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionHold_candidate_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionHold_holdAudit_fkey"
    FOREIGN KEY ("holdAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionHold_releaseAudit_fkey"
    FOREIGN KEY ("releaseAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "ChatUnifiedOptimizerCandidateRetentionReceipt" (
  "candidateId" UUID NOT NULL PRIMARY KEY,
  "auditLogId" TEXT NOT NULL UNIQUE,
  "deletedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionReceipt_candidate_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ChatUnifiedOptimizerCandidateRetentionReceipt_audit_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Serialize payload deletion against promotion's exact-payload check.
CREATE OR REPLACE FUNCTION "chat_unified_optimizer_promotion_payload_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "ChatUnifiedOptimizerCandidate"
    WHERE "id" = NEW."candidateId" FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerCandidatePayload" p
    JOIN "ChatUnifiedOptimizerCandidate" c ON c."id" = p."candidateId"
    WHERE p."candidateId" = NEW."candidateId"
      AND c."cycleId" = NEW."cycleId"
      AND c."candidateDigest" = NEW."candidateDigest"
      AND c."bundleDigest" = NEW."candidateBundleDigest"
      AND p."bundleDigest" = NEW."candidateBundleDigest"
      AND p."bodySha256" =
        encode(sha256(convert_to(p."bundleJson", 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_promotion_payload_refused'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "chat_unified_optimizer_candidate_payload_expiry_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_id TEXT;
  cycle_state TEXT;
  cycle_terminal_at TIMESTAMPTZ;
  pointer_row "ChatUnifiedOptimizerActivePointer"%ROWTYPE;
  last_retired_at TIMESTAMPTZ;
  ever_pointed BOOLEAN;
BEGIN
  audit_id := current_setting('app.chat_unified_optimizer_retention_audit_id', true);
  IF audit_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM "AdminAuditLog" a
    WHERE a."id" = audit_id
      AND a."action" = 'chat.unified_optimizer.candidate_body_expired'
      AND a."targetType" = 'ChatUnifiedOptimizerCandidatePayload'
      AND a."targetId" = OLD."candidateId"::text
      AND a."actorUserId" IS NULL
      AND a."metadata"->>'systemActor' = 'chat-unified-optimizer'
      AND a."entryHash" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_retention_audit_required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO pointer_row FROM "ChatUnifiedOptimizerActivePointer"
    WHERE "productKey" = 'internal-chat-optimization' FOR SHARE;
  PERFORM 1 FROM "ChatUnifiedOptimizerCandidate"
    WHERE "id" = OLD."candidateId" FOR UPDATE;
  SELECT y."state", y."terminalAt" INTO cycle_state, cycle_terminal_at
    FROM "ChatUnifiedOptimizerCandidate" c
    JOIN "ChatUnifiedOptimizerCycle" y ON y."id" = c."cycleId"
    WHERE c."id" = OLD."candidateId";
  IF cycle_state NOT IN ('succeeded', 'failed') OR
      cycle_terminal_at IS NULL THEN
    RAISE EXCEPTION 'chat_unified_optimizer_retention_not_terminal'
      USING ERRCODE = 'P0001';
  END IF;
  IF pointer_row."productKey" IS NULL OR
      pointer_row."candidateId" = OLD."candidateId" OR EXISTS (
        SELECT 1 FROM "ChatUnifiedOptimizerPointerSnapshot" s
        WHERE s."productKey" = pointer_row."productKey"
          AND s."revision" = pointer_row."revision" - 1
          AND s."candidateId" = OLD."candidateId"
      ) OR EXISTS (
        SELECT 1 FROM "ChatUnifiedOptimizerCandidateRetentionHold" h
        WHERE h."candidateId" = OLD."candidateId"
          AND h."releasedAt" IS NULL
      ) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_retention_referenced_or_held'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "ChatUnifiedOptimizerPointerSnapshot" s
    WHERE s."candidateId" = OLD."candidateId"
  ) INTO ever_pointed;
  SELECT MAX(next."createdAt") INTO last_retired_at
    FROM "ChatUnifiedOptimizerPointerSnapshot" previous
    JOIN "ChatUnifiedOptimizerPointerSnapshot" next
      ON next."productKey" = previous."productKey"
      AND next."revision" = previous."revision" + 1
    WHERE previous."candidateId" = OLD."candidateId"
      AND next."candidateId" IS DISTINCT FROM OLD."candidateId";
  IF (ever_pointed AND last_retired_at IS NULL) OR
      GREATEST(cycle_terminal_at, COALESCE(last_retired_at, cycle_terminal_at))
        + INTERVAL '30 days' > clock_timestamp() THEN
    RAISE EXCEPTION 'chat_unified_optimizer_retention_not_due'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION "chat_unified_optimizer_candidate_payload_expiry_receipt"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ChatUnifiedOptimizerCandidateRetentionReceipt"
    ("candidateId", "auditLogId", "deletedAt") VALUES
    (OLD."candidateId",
     current_setting('app.chat_unified_optimizer_retention_audit_id', true),
     clock_timestamp());
  RETURN NULL;
END;
$$;

DROP TRIGGER "ChatUnifiedOptimizerCandidatePayload_immutable"
  ON "ChatUnifiedOptimizerCandidatePayload";
CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_immutable_update"
BEFORE UPDATE ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_expiry_guard"
BEFORE DELETE ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_candidate_payload_expiry_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_expiry_receipt"
AFTER DELETE ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_candidate_payload_expiry_receipt"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidateRetentionReceipt_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerCandidateRetentionReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidateRetentionReceipt_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCandidateRetentionReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidateRetentionHold_no_delete"
BEFORE DELETE ON "ChatUnifiedOptimizerCandidateRetentionHold"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidateRetentionHold_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCandidateRetentionHold"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
