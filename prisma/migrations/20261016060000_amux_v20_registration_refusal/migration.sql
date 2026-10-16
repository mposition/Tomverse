-- AMUX intake v20 item 5: preserve a deterministic Task registration refusal
-- for operator review after the attempted registration transaction rolls back.
-- The row contains closed metadata only; expected paths and proposal text are
-- neither columns nor audit metadata.
-- baseline-check: present-if-relation "AmuxIdeaRegistrationRefusal"
BEGIN;

CREATE TABLE "AmuxIdeaRegistrationRefusal" (
  "id" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "attemptKind" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "refusalCode" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "draftUnitId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "analysisPreviewId" TEXT NOT NULL,
  "sourcePlanRevisionId" TEXT NOT NULL,
  "proposedExecutionGrade" TEXT,
  "finalExecutionGrade" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL,
  "auditLogId" TEXT NOT NULL,

  CONSTRAINT "AmuxIdeaRegistrationRefusal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaRegistrationRefusal_attempt_kind_check" CHECK (
    "attemptKind" IN ('prepare', 'consume', 'whole_plan')
  ),
  CONSTRAINT "AmuxIdeaRegistrationRefusal_state_check" CHECK (
    "state" = 'awaiting_operator'
  ),
  CONSTRAINT "AmuxIdeaRegistrationRefusal_code_check" CHECK (
    "refusalCode" IN (
      'task_expected_paths_missing',
      'task_expected_paths_out_of_range',
      'task_expected_path_invalid',
      'task_expected_paths_duplicate',
      'task_expected_paths_mixed',
      'task_role_review_refused',
      'task_execution_grade_mismatch',
      'task_confirmation_grade_mismatch',
      'task_cost_receipt_grade_mismatch'
    )
  ),
  CONSTRAINT "AmuxIdeaRegistrationRefusal_proposed_grade_check" CHECK (
    "proposedExecutionGrade" IS NULL OR
    "proposedExecutionGrade" IN ('routine', 'advanced', 'frontier')
  ),
  CONSTRAINT "AmuxIdeaRegistrationRefusal_final_grade_check" CHECK (
    "finalExecutionGrade" IS NULL OR
    "finalExecutionGrade" IN ('routine', 'advanced', 'frontier')
  )
);

CREATE UNIQUE INDEX "AmuxIdeaRegistrationRefusal_requestId_key"
  ON "AmuxIdeaRegistrationRefusal"("requestId");
CREATE UNIQUE INDEX "AmuxIdeaRegistrationRefusal_auditLogId_key"
  ON "AmuxIdeaRegistrationRefusal"("auditLogId");
CREATE INDEX "AmuxIdeaRegistrationRefusal_ideaId_state_attemptedAt_idx"
  ON "AmuxIdeaRegistrationRefusal"("ideaId", "state", "attemptedAt");
CREATE INDEX "AmuxIdeaRegistrationRefusal_draftUnitId_attemptedAt_idx"
  ON "AmuxIdeaRegistrationRefusal"("draftUnitId", "attemptedAt");

ALTER TABLE "AmuxIdeaRegistrationRefusal"
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId")
    REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_draftUnitId_fkey"
    FOREIGN KEY ("draftUnitId") REFERENCES "AmuxIdeaDraftUnit"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_analysisPreviewId_fkey"
    FOREIGN KEY ("analysisPreviewId") REFERENCES "AmuxIdeaTransferPreview"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_sourcePlanRevisionId_fkey"
    FOREIGN KEY ("sourcePlanRevisionId") REFERENCES "AmuxIdeaSourcePlanRevision"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v20_registration_refusal_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  unit_row record;
  preview_row record;
  audit_row record;
  metadata jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AMUX v20 registration refusals are append-only'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaRegistrationRefusal_append_only_check';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "id", "ideaId", "actorUserId", "chunkIndex", "unitKind"
    INTO unit_row FROM "AmuxIdeaDraftUnit"
    WHERE "id" = NEW."draftUnitId" FOR KEY SHARE;
  SELECT "id", "ideaId", "chunkIndex", "sourcePlanRevisionId"
    INTO preview_row FROM "AmuxIdeaTransferPreview"
    WHERE "id" = NEW."analysisPreviewId" FOR KEY SHARE;
  SELECT a.*, a.xmin = pg_current_xact_id()::xid AS audit_same_transaction
    INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."auditLogId" FOR KEY SHARE;
  metadata := audit_row."metadata";

  IF unit_row."id" IS NULL OR unit_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     unit_row."actorUserId" IS DISTINCT FROM NEW."actorUserId" OR
     unit_row."unitKind" IS DISTINCT FROM 'card' OR
     preview_row."id" IS NULL OR preview_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     preview_row."chunkIndex" IS DISTINCT FROM unit_row."chunkIndex" OR
     preview_row."sourcePlanRevisionId" IS DISTINCT FROM NEW."sourcePlanRevisionId" OR
     audit_row."id" IS NULL OR audit_row.audit_same_transaction IS NOT TRUE OR
     audit_row."actorUserId" IS DISTINCT FROM NEW."actorUserId" OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" IS DISTINCT FROM 'amux.v20.registration.refuse' OR
     audit_row."targetType" IS DISTINCT FROM 'AmuxIdeaRegistrationRefusal' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
     audit_row."summary" IS DISTINCT FROM
       'Recorded one deterministic AMUX v20 Task registration refusal for operator review.' OR
     jsonb_typeof(metadata) IS DISTINCT FROM 'object' OR
     (metadata ?& ARRAY[
       'policyVersion', 'state', 'requestId', 'attemptKind', 'refusalCode',
       'ideaId', 'draftUnitId', 'analysisPreviewId', 'sourcePlanRevisionId',
       'proposedExecutionGrade', 'finalExecutionGrade', 'attemptedAt'
     ]) IS NOT TRUE OR
     metadata - ARRAY[
       'policyVersion', 'state', 'requestId', 'attemptKind', 'refusalCode',
       'ideaId', 'draftUnitId', 'analysisPreviewId', 'sourcePlanRevisionId',
       'proposedExecutionGrade', 'finalExecutionGrade', 'attemptedAt'
     ] <> '{}'::jsonb OR
     metadata->>'policyVersion' IS DISTINCT FROM '20' OR
     metadata->>'state' IS DISTINCT FROM NEW."state" OR
     metadata->>'requestId' IS DISTINCT FROM NEW."requestId"::text OR
     metadata->>'attemptKind' IS DISTINCT FROM NEW."attemptKind" OR
     metadata->>'refusalCode' IS DISTINCT FROM NEW."refusalCode" OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->>'draftUnitId' IS DISTINCT FROM NEW."draftUnitId" OR
     metadata->>'analysisPreviewId' IS DISTINCT FROM NEW."analysisPreviewId" OR
     metadata->>'sourcePlanRevisionId' IS DISTINCT FROM NEW."sourcePlanRevisionId" OR
     metadata->>'proposedExecutionGrade' IS DISTINCT FROM NEW."proposedExecutionGrade" OR
     metadata->>'finalExecutionGrade' IS DISTINCT FROM NEW."finalExecutionGrade" OR
     metadata->>'attemptedAt' IS DISTINCT FROM
       to_char(NEW."attemptedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'AMUX v20 registration refusal evidence mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaRegistrationRefusal_evidence_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaRegistrationRefusal_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaRegistrationRefusal"
  FOR EACH ROW EXECUTE FUNCTION "amux_v20_registration_refusal_guard"();

CREATE FUNCTION "amux_v20_registration_refusal_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'AMUX v20 registration refusals are append-only'
    USING ERRCODE = '23514',
      CONSTRAINT = 'AmuxIdeaRegistrationRefusal_append_only_check';
END;
$$;

CREATE TRIGGER "AmuxIdeaRegistrationRefusal_truncate_guard"
  BEFORE TRUNCATE ON "AmuxIdeaRegistrationRefusal"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_v20_registration_refusal_truncate_guard"();

COMMIT;
