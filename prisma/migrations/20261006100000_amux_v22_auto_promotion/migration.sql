-- V22 is additive and dark. No control row, receipt, or status is seeded.
BEGIN;

CREATE TABLE "AmuxV22PromotionControl" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "active" BOOLEAN NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "activatedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22PromotionControl_singleton_check" CHECK ("id" = 'queue')
);

CREATE TABLE "AmuxV22PromotionReceipt" (
  "id" UUID NOT NULL PRIMARY KEY,
  "workItemId" TEXT NOT NULL UNIQUE REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceApprovalId" TEXT NOT NULL,
  "sourceApprovalDigest" TEXT NOT NULL,
  "briefDigest" TEXT NOT NULL,
  "parentFeatureNodeId" TEXT NOT NULL,
  "parentStoryCardId" TEXT,
  "taskRevision" INTEGER NOT NULL,
  "scoreSnapshotId" UUID NOT NULL REFERENCES "AmuxPortfolioScoreSnapshot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "scoreVersion" TEXT NOT NULL,
  "scoreTotal" INTEGER NOT NULL,
  "capacityWipLimit" INTEGER NOT NULL,
  "capacityOccupied" INTEGER NOT NULL,
  "verifiedWorkerCount" INTEGER NOT NULL,
  "queueLimit" INTEGER NOT NULL,
  "normalLimit" INTEGER NOT NULL,
  "parallelReserved" INTEGER NOT NULL,
  "sev1Reserved" INTEGER NOT NULL,
  "costCents" INTEGER NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "promotedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22PromotionReceipt_shape_check" CHECK (
    "sourceApprovalDigest" ~ '^[a-f0-9]{64}$' AND
    "briefDigest" ~ '^[a-f0-9]{64}$' AND
    "taskRevision" >= 0 AND "capacityWipLimit" > 0 AND
    "capacityOccupied" >= 0 AND "verifiedWorkerCount" > 0 AND
    "queueLimit" > 0 AND "normalLimit" >= 0 AND
    "parallelReserved" = 1 AND "sev1Reserved" = 1 AND
    "capacityOccupied" < "normalLimit" AND
    "normalLimit" + "parallelReserved" + "sev1Reserved" = "queueLimit" AND
    "queueLimit" <= "capacityWipLimit" AND
    "queueLimit" <= "verifiedWorkerCount" * 3 AND
    "costCents" = 0 AND "policyVersion" = 22
  )
);

CREATE TABLE "AmuxV22PromotionUnknown" (
  "id" UUID NOT NULL PRIMARY KEY,
  "workItemId" TEXT,
  "receiptFound" BOOLEAN NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AmuxV22PromotionUnknown_recordedAt_idx"
  ON "AmuxV22PromotionUnknown"("recordedAt");

ALTER TABLE "AmuxOrchestratorWriteReceipt"
  DROP CONSTRAINT "AmuxOrchestratorWriteReceipt_target_kind_check",
  ADD CONSTRAINT "AmuxOrchestratorWriteReceipt_target_kind_check"
  CHECK ("targetKind" IN ('work_item', 'claim_decision', 'execution_attempt',
    'auto_promotion_grant', 'auto_promotion_consumption',
    'v22_promotion_receipt', 'v22_promotion_unknown',
    'v22_promotion_halt',
    'quota_observation_batch'));

ALTER TABLE "AmuxWorkItem"
  ALTER COLUMN "v22ReceiptId" TYPE UUID USING "v22ReceiptId"::uuid;
ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_v22ReceiptId_fkey"
  FOREIGN KEY ("v22ReceiptId") REFERENCES "AmuxV22PromotionReceipt"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- V4 Task plaintext remains excluded. The receipt, not a legacy execution
-- brief or a v8 grant, is the only exception to the sourced-todo check.
ALTER TABLE "AmuxWorkItem"
  DROP CONSTRAINT "AmuxWorkItem_sourced_todo_has_brief_check",
  ADD CONSTRAINT "AmuxWorkItem_sourced_todo_has_brief_check"
  CHECK ("status" <> 'todo' OR "sourceSystem" IS NULL OR
    "executionBrief" IS NOT NULL OR
    ("sourceSystem" = 'admin-idea-v4' AND "cardType" = 'task' AND
     "v22ReceiptId" IS NOT NULL)) NOT VALID;

ALTER TABLE "AmuxWorkItem"
  DROP CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check",
  ADD CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check"
  CHECK ("sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
    ("owner" IS NULL AND "claimedAt" IS NULL AND
     ("status" IN ('backlog', 'blocked', 'cancelled') OR
      ("cardType" = 'task' AND "status" = 'todo' AND
       "v22ReceiptId" IS NOT NULL)))) NOT VALID;

-- A forged pointer cannot turn a Story or an unapproved Task into Todo.
-- The receipt's system audit is required, and the approval/score bindings
-- must still name this exact card and revision. This runs at COMMIT so the
-- receipt and status may be inserted in either order within one transaction.
CREATE FUNCTION amux_v22_card_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r "AmuxV22PromotionReceipt"%ROWTYPE;
  s "AmuxPortfolioScoreSnapshot"%ROWTYPE;
  a "AdminAuditLog"%ROWTYPE;
  d "AmuxIdeaUnitDecision"%ROWTYPE;
BEGIN
  IF NEW."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     NEW."cardType" IS DISTINCT FROM 'task' OR
     NEW."status" NOT IN ('todo', 'doing', 'review', 'done') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM "AmuxV22PromotionReceipt"
    WHERE "id" = NEW."v22ReceiptId" AND "workItemId" = NEW."id";
  SELECT * INTO s FROM "AmuxPortfolioScoreSnapshot"
    WHERE "id" = r."scoreSnapshotId";
  SELECT * INTO a FROM "AdminAuditLog"
    WHERE "id" = r."authorizationAuditLogId";
  SELECT * INTO d FROM "AmuxIdeaUnitDecision"
    WHERE "id" = NEW."v4SourceApprovalId";
  IF r."id" IS NULL OR s."id" IS NULL OR a."id" IS NULL OR d."id" IS NULL OR
     r."sourceApprovalId" IS DISTINCT FROM NEW."v4SourceApprovalId" OR
     r."sourceApprovalDigest" IS DISTINCT FROM d."confirmationDigest" OR
     d."state" IS DISTINCT FROM 'consumed' OR
     d."registeredWorkItemId" IS DISTINCT FROM NEW."id" OR
     r."briefDigest" IS DISTINCT FROM NEW."v4BriefDigest" OR
     r."parentFeatureNodeId" IS DISTINCT FROM NEW."parentFeatureNodeId" OR
     r."parentStoryCardId" IS DISTINCT FROM NEW."parentStoryCardId" OR
     r."taskRevision" IS DISTINCT FROM s."taskRevision" OR
     r."scoreVersion" IS DISTINCT FROM s."scoreVersion" OR
     r."scoreTotal" IS DISTINCT FROM s."scoreTotal" OR
     s."taskId" IS DISTINCT FROM NEW."id" OR
     s."sourceApprovalId" IS DISTINCT FROM NEW."v4SourceApprovalId" OR
     a."action" IS DISTINCT FROM 'amux.v22.auto_promotion.consumed' OR
     a."targetType" IS DISTINCT FROM 'AmuxV22PromotionReceipt' OR
     a."targetId" IS DISTINCT FROM r."id"::text OR
     a."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v22-auto-admit' OR
     a."entryHash" IS NULL THEN
    RAISE EXCEPTION 'v22 promotion receipt is not bound'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22PromotionReceipt_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_card_receipt_guard_trigger
AFTER INSERT OR UPDATE ON "AmuxWorkItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION amux_v22_card_receipt_guard();

CREATE FUNCTION amux_v22_promotion_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'v22 promotion evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22Promotion_append_only_check';
END $$;
CREATE TRIGGER amux_v22_receipt_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "AmuxV22PromotionReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_promotion_append_only();
CREATE TRIGGER amux_v22_unknown_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "AmuxV22PromotionUnknown"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_promotion_append_only();

ALTER TABLE "AmuxWorkItem"
  VALIDATE CONSTRAINT "AmuxWorkItem_sourced_todo_has_brief_check";
ALTER TABLE "AmuxWorkItem"
  VALIDATE CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check";
ALTER TABLE "AmuxWorkItem"
  VALIDATE CONSTRAINT "AmuxWorkItem_v22ReceiptId_fkey";
COMMIT;
