-- Intake v19 item 5: allow the scoped registrar to persist one refusal
-- only after its whole-plan transaction rolls back.
-- baseline-check: replace-function-if-body-sha256 "amux_v20_registration_refusal_guard" "2408dcdcd917f1de0ce6ed7b7e5700758e57c16b5914917b68cf60c1caf3a3ce"
CREATE OR REPLACE FUNCTION "amux_v20_registration_refusal_guard"() RETURNS trigger
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
     unit_row."unitKind" NOT IN ('node', 'card') OR
     preview_row."id" IS NULL OR preview_row."ideaId" IS DISTINCT FROM NEW."ideaId" OR
     preview_row."chunkIndex" IS DISTINCT FROM unit_row."chunkIndex" OR
     preview_row."sourcePlanRevisionId" IS DISTINCT FROM NEW."sourcePlanRevisionId" OR
     audit_row."id" IS NULL OR audit_row.audit_same_transaction IS NOT TRUE OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" IS DISTINCT FROM 'amux.v20.registration.refuse' OR
     audit_row."targetType" IS DISTINCT FROM 'AmuxIdeaRegistrationRefusal' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id"::text OR
     audit_row."summary" IS DISTINCT FROM
       'Recorded one deterministic AMUX registration refusal for operator review.' OR
     jsonb_typeof(metadata) IS DISTINCT FROM 'object' OR
     (metadata ?& ARRAY[
       'policyVersion', 'state', 'requestId', 'attemptKind', 'refusalCode',
       'ideaId', 'draftUnitId', 'analysisPreviewId', 'sourcePlanRevisionId',
       'proposedExecutionGrade', 'finalExecutionGrade', 'attemptedAt'
     ]) IS NOT TRUE OR
     NOT (
       (audit_row."actorUserId" = NEW."actorUserId" AND
        unit_row."unitKind" = 'card' AND
        NEW."refusalCode" NOT IN (
          'plan_schema_invalid', 'plan_hierarchy_invalid',
          'plan_dependency_invalid', 'plan_dependency_cycle',
          'plan_score_invalid', 'plan_duplicate_unresolved'
        ) AND
        metadata->>'systemActor' IS NULL AND
        metadata - ARRAY[
          'policyVersion', 'state', 'requestId', 'attemptKind', 'refusalCode',
          'ideaId', 'draftUnitId', 'analysisPreviewId', 'sourcePlanRevisionId',
          'proposedExecutionGrade', 'finalExecutionGrade', 'attemptedAt'
        ] = '{}'::jsonb) OR
       (audit_row."actorUserId" IS NULL AND audit_row."actorEmail" IS NULL AND
        audit_row."ipAddress" IS NULL AND audit_row."userAgent" IS NULL AND
        NEW."attemptKind" = 'whole_plan' AND
        metadata->>'systemActor' = 'amux-v4-intake' AND
        metadata->>'actorScope' = 'system-registration-refusal-v1' AND
        metadata - ARRAY[
          'systemActor', 'actorScope', 'policyVersion', 'state', 'requestId',
          'attemptKind', 'refusalCode', 'ideaId', 'draftUnitId',
          'analysisPreviewId', 'sourcePlanRevisionId',
          'proposedExecutionGrade', 'finalExecutionGrade', 'attemptedAt'
        ] = '{}'::jsonb)
     ) OR
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
