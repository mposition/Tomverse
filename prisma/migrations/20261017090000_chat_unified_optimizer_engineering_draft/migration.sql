-- A closed, case-blind suggestion for an owner to register as an AMUX code task.
-- It carries no patch, hidden case, judge prose, task registration or publisher grant.
CREATE TABLE "ChatUnifiedOptimizerEngineeringDraft" (
  "cycleId" UUID NOT NULL PRIMARY KEY,
  "requestId" UUID NOT NULL UNIQUE,
  "requestDigest" TEXT NOT NULL,
  "summaryDigest" TEXT NOT NULL,
  "targetArea" TEXT NOT NULL,
  "proposalKind" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ChatUnifiedOptimizerEngineeringDraft_content_check" CHECK (
    "requestDigest" ~ '^[0-9a-f]{64}$'
    AND "summaryDigest" ~ '^[0-9a-f]{64}$'
    AND "targetArea" IN ('router_selection', 'refiner_decision',
      'shared_parser', 'fixed_wrapper', 'admission_guard')
    AND "proposalKind" IN ('quality_gap_requires_code',
      'candidate_scope_exceeded', 'deterministic_guard_review')
  )
);

ALTER TABLE "ChatUnifiedOptimizerEngineeringDraft"
  ADD CONSTRAINT "ChatUnifiedOptimizerEngineeringDraft_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerEngineeringDraft_verdict_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerComparisonVerdict"("cycleId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerEngineeringDraft_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ChatUnifiedOptimizerEngineeringDraft_createdAt_idx"
  ON "ChatUnifiedOptimizerEngineeringDraft"("createdAt");

CREATE FUNCTION "chat_unified_optimizer_engineering_draft_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'chat_unified_optimizer_engineering_draft_immutable';
END;
$$;
CREATE TRIGGER "chat_unified_optimizer_engineering_draft_immutable"
  BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerEngineeringDraft"
  FOR EACH ROW EXECUTE FUNCTION
    "chat_unified_optimizer_engineering_draft_immutable"();
