-- A13 is additive and dark. A v4 Todo may be assigned, but may not execute.
BEGIN;

CREATE TABLE "AmuxV22LaneDecision" (
  "sequence" BIGSERIAL PRIMARY KEY,
  "workItemId" TEXT NOT NULL REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "lane" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "decidedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22LaneDecision_lane_check" CHECK ("lane" IN ('normal', 'parallel', 'sev1'))
);
CREATE INDEX "AmuxV22LaneDecision_workItemId_sequence_idx"
  ON "AmuxV22LaneDecision"("workItemId", "sequence");

CREATE TABLE "AmuxV22WorkerAssignment" (
  "id" UUID PRIMARY KEY,
  "workItemId" TEXT NOT NULL REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "promotionReceiptId" UUID NOT NULL REFERENCES "AmuxV22PromotionReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "laneDecisionSequence" BIGINT REFERENCES "AmuxV22LaneDecision"("sequence") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "lane" TEXT NOT NULL,
  "taskRevision" INTEGER NOT NULL,
  "workerName" TEXT NOT NULL,
  "workerInstanceId" TEXT NOT NULL,
  "workerGeneration" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "grade" TEXT NOT NULL,
  "routeId" TEXT NOT NULL,
  "routePolicyDigest" TEXT NOT NULL,
  "catalogApprovalId" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "costReceiptDigest" TEXT NOT NULL,
  "perAttemptMicroUsd" BIGINT NOT NULL,
  "authorizationAuditLogId" TEXT NOT NULL UNIQUE REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assignedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxV22WorkerAssignment_shape_check" CHECK (
    "lane" IN ('normal', 'parallel', 'sev1') AND "taskRevision" >= 0 AND
    "workerGeneration" > 0 AND length("workerName") BETWEEN 1 AND 120 AND
    length("provider") BETWEEN 1 AND 80 AND length("modelId") BETWEEN 1 AND 160 AND
    length("role") BETWEEN 1 AND 64 AND length("grade") BETWEEN 1 AND 64 AND
    "routePolicyDigest" ~ '^[a-f0-9]{64}$' AND
    "costReceiptDigest" ~ '^[a-f0-9]{64}$' AND "perAttemptMicroUsd" >= 0)
);
CREATE INDEX "AmuxV22WorkerAssignment_workItemId_assignedAt_idx"
  ON "AmuxV22WorkerAssignment"("workItemId", "assignedAt");
ALTER TABLE "AmuxWorkItem"
  ADD COLUMN "v22AssignmentId" UUID UNIQUE;
ALTER TABLE "AmuxWorkItem"
  ADD CONSTRAINT "AmuxWorkItem_v22AssignmentId_fkey"
  FOREIGN KEY ("v22AssignmentId") REFERENCES "AmuxV22WorkerAssignment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "AmuxOrchestratorWriteReceipt"
  DROP CONSTRAINT "AmuxOrchestratorWriteReceipt_target_kind_check",
  ADD CONSTRAINT "AmuxOrchestratorWriteReceipt_target_kind_check"
  CHECK ("targetKind" IN ('work_item', 'claim_decision', 'execution_attempt',
    'auto_promotion_grant', 'auto_promotion_consumption',
    'v22_promotion_receipt', 'v22_promotion_unknown', 'v22_promotion_halt',
    'v22_worker_assignment',
    'quota_observation_batch'));

ALTER TABLE "AmuxWorkItem"
  DROP CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check",
  ADD CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check"
  CHECK ("sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
    (("status" IN ('backlog', 'blocked', 'cancelled') AND
      "owner" IS NULL AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL) OR
     ("cardType" = 'task' AND "status" = 'todo' AND "v22ReceiptId" IS NOT NULL AND
      (("owner" IS NULL AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL) OR
       ("owner" IS NOT NULL AND "claimedAt" IS NOT NULL AND "v22AssignmentId" IS NOT NULL))))) NOT VALID;

-- A lane is a human decision. No model or worker can forge this audit binding.
CREATE FUNCTION amux_v22_lane_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a "AdminAuditLog"%ROWTYPE;
        w "AmuxWorkItem"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "AdminAuditLog" WHERE "id" = NEW."authorizationAuditLogId";
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."workItemId";
  IF w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     w."cardType" IS DISTINCT FROM 'task' OR
     w."status" IS DISTINCT FROM 'todo' OR w."owner" IS NOT NULL OR
     w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL OR
     a."id" IS NULL OR a."entryHash" IS NULL OR
     a."action" IS DISTINCT FROM 'amux.v22.lane.declared' OR
     a."targetType" IS DISTINCT FROM 'AmuxV22LaneDecision' OR
     a."targetId" IS DISTINCT FROM NEW."sequence"::text OR
     a."metadata"->>'taskId' IS DISTINCT FROM NEW."workItemId" OR
     a."metadata"->>'lane' IS DISTINCT FROM NEW."lane" OR
     a."actorUserId" IS DISTINCT FROM NEW."approvedByUserId" THEN
    RAISE EXCEPTION 'v22 lane decision is not owner audited'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22LaneDecision_audit_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_lane_guard_trigger
AFTER INSERT ON "AmuxV22LaneDecision" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION amux_v22_lane_guard();

-- The card pointer is the assignment authority. An owner string alone is not.
CREATE FUNCTION amux_v22_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r "AmuxV22WorkerAssignment"%ROWTYPE;
        p "AmuxV22PromotionReceipt"%ROWTYPE;
        a "AdminAuditLog"%ROWTYPE;
        l "AmuxV22LaneDecision"%ROWTYPE;
BEGIN
  IF NEW."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     NEW."cardType" IS DISTINCT FROM 'task' OR NEW."status" <> 'todo' OR
     NEW."owner" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM "AmuxV22WorkerAssignment"
    WHERE "id" = NEW."v22AssignmentId" AND "workItemId" = NEW."id";
  SELECT * INTO p FROM "AmuxV22PromotionReceipt"
    WHERE "id" = r."promotionReceiptId" AND "workItemId" = NEW."id";
  SELECT * INTO a FROM "AdminAuditLog" WHERE "id" = r."authorizationAuditLogId";
  IF r."laneDecisionSequence" IS NOT NULL THEN
    SELECT * INTO l FROM "AmuxV22LaneDecision" WHERE "sequence" = r."laneDecisionSequence";
  END IF;
  IF r."id" IS NULL OR p."id" IS NULL OR a."id" IS NULL OR a."entryHash" IS NULL OR
     NEW."v22ReceiptId" IS DISTINCT FROM p."id" OR
     NEW."owner" IS DISTINCT FROM r."workerName" OR
     NEW."claimedAt" IS DISTINCT FROM r."assignedAt" OR
     NEW."revision" IS DISTINCT FROM r."taskRevision" + 1 OR
     NEW."taskRole" IS DISTINCT FROM r."role" OR
     NEW."executionGrade" IS DISTINCT FROM r."grade" OR
     NEW."v4SourceApprovalId" IS DISTINCT FROM p."sourceApprovalId" OR
     NEW."v4BriefDigest" IS DISTINCT FROM p."briefDigest" OR
     a."action" IS DISTINCT FROM 'amux.v22.worker.assigned' OR
     a."targetType" IS DISTINCT FROM 'AmuxV22WorkerAssignment' OR
     a."targetId" IS DISTINCT FROM r."id"::text OR
     a."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v22-worker-claim' OR
     a."metadata"->>'taskId' IS DISTINCT FROM NEW."id" OR
     a."metadata"->>'workerName' IS DISTINCT FROM r."workerName" OR
     a."metadata"->>'lane' IS DISTINCT FROM r."lane" OR
     (r."laneDecisionSequence" IS NULL AND r."lane" <> 'normal') OR
     (r."laneDecisionSequence" IS NOT NULL AND
       (l."workItemId" IS DISTINCT FROM NEW."id" OR l."lane" IS DISTINCT FROM r."lane")) THEN
    RAISE EXCEPTION 'v22 assignment is not bound'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22WorkerAssignment_binding_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_assignment_guard_trigger
AFTER INSERT OR UPDATE ON "AmuxWorkItem" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION amux_v22_assignment_guard();

CREATE FUNCTION amux_v22_assignment_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w "AmuxWorkItem"%ROWTYPE;
        a "AdminAuditLog"%ROWTYPE;
        latest BIGINT;
BEGIN
  SELECT * INTO w FROM "AmuxWorkItem" WHERE "id" = NEW."workItemId";
  SELECT * INTO a FROM "AdminAuditLog" WHERE "id" = NEW."authorizationAuditLogId";
  SELECT d."sequence" INTO latest FROM "AmuxV22LaneDecision" d
    WHERE d."workItemId" = NEW."workItemId"
    ORDER BY d."sequence" DESC LIMIT 1;
  IF w."v22AssignmentId" IS DISTINCT FROM NEW."id" OR
     w."owner" IS DISTINCT FROM NEW."workerName" OR
     w."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     w."cardType" IS DISTINCT FROM 'task' OR
     w."status" IS DISTINCT FROM 'todo' OR
     latest IS DISTINCT FROM NEW."laneDecisionSequence" OR
     a."id" IS NULL OR a."entryHash" IS NULL OR
     a."action" IS DISTINCT FROM 'amux.v22.worker.assigned' OR
     a."targetType" IS DISTINCT FROM 'AmuxV22WorkerAssignment' OR
     a."targetId" IS DISTINCT FROM NEW."id"::text OR
     a."metadata"->>'taskId' IS DISTINCT FROM NEW."workItemId" OR
     a."metadata"->>'workerName' IS DISTINCT FROM NEW."workerName" OR
     a."metadata"->>'systemActor' IS DISTINCT FROM 'amux-v22-worker-claim' THEN
    RAISE EXCEPTION 'v22 assignment receipt is not accepted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22WorkerAssignment_receipt_check';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER amux_v22_assignment_row_guard_trigger
AFTER INSERT ON "AmuxV22WorkerAssignment" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION amux_v22_assignment_row_guard();

CREATE FUNCTION amux_v22_assignment_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'v22 assignment evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxV22Assignment_append_only_check';
END $$;
CREATE TRIGGER amux_v22_lane_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "AmuxV22LaneDecision"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_assignment_append_only();
CREATE TRIGGER amux_v22_assignment_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "AmuxV22WorkerAssignment"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v22_assignment_append_only();

ALTER TABLE "AmuxWorkItem" VALIDATE CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check";
ALTER TABLE "AmuxWorkItem" VALIDATE CONSTRAINT "AmuxWorkItem_v22AssignmentId_fkey";
COMMIT;
