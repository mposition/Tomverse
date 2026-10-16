-- Preserve the v4 owner approval binding. The sole grade revision is an
-- audited, attempt-bound routine/advanced -> frontier contract-path escalation.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v4_task_approval_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."sourceSystem" = 'admin-idea-v4' AND OLD."cardType" = 'task' THEN
    IF NEW."sourceSystem" IS DISTINCT FROM OLD."sourceSystem" OR
       NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest" OR
       NEW."v4SourceApprovalId" IS DISTINCT FROM OLD."v4SourceApprovalId" OR
       NEW."v4BodyDigest" IS DISTINCT FROM OLD."v4BodyDigest" OR
       NEW."v4BodyDigestKeyId" IS DISTINCT FROM OLD."v4BodyDigestKeyId" OR
       NEW."v4BriefDigest" IS DISTINCT FROM OLD."v4BriefDigest" OR
       NEW."v4BriefDigestKeyId" IS DISTINCT FROM OLD."v4BriefDigestKeyId" OR
       NEW."taskRole" IS DISTINCT FROM OLD."taskRole" OR
       NEW."parentFeatureNodeId" IS DISTINCT FROM OLD."parentFeatureNodeId" OR
       NEW."parentStoryCardId" IS DISTINCT FROM OLD."parentStoryCardId" THEN
      RAISE EXCEPTION 'AMUX v4 Task approval binding is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_binding_check';
    END IF;

    IF NEW."executionGrade" IS DISTINCT FROM OLD."executionGrade" THEN
      IF (OLD."executionGrade" IN ('routine', 'advanced') AND
          NEW."executionGrade" = 'frontier' AND
          OLD."status" = 'doing' AND NEW."status" = 'todo' AND
          OLD."v22AssignmentId" IS NOT NULL AND
          NEW."v22AssignmentId" IS NULL AND
          OLD."owner" IS NOT NULL AND NEW."owner" IS NULL AND
          NEW."revision" = OLD."revision" + 1) IS NOT TRUE OR
         NOT EXISTS (
           SELECT 1 FROM "AdminAuditLog" a
           JOIN "AmuxExecutionAttempt" e
             ON e."id" = a."metadata"->>'attemptId'
           JOIN "AmuxIdeaUnitDecision" d
             ON d."id" = OLD."v4SourceApprovalId"
           WHERE a."action" = 'amux.grade.escalated' AND
             a."targetType" = 'AmuxWorkItem' AND
             a."targetId" = OLD."id" AND
             a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND
             a."ipAddress" IS NULL AND a."userAgent" IS NULL AND
             a."entryHash" IS NOT NULL AND
             a.xmin = pg_current_xact_id()::xid AND
             jsonb_typeof(a."metadata") = 'object' AND
             a."metadata"->>'systemActor' = 'tomverse-amux-orchestrator' AND
             a."metadata"->>'reason' = 'contract_path_touched' AND
             a."metadata"->>'classificationFailure' = 'true' AND
             a."metadata"->>'previousGrade' = OLD."executionGrade" AND
             a."metadata"->>'nextGrade' = 'frontier' AND
             a."metadata"->>'assignmentId' = OLD."v22AssignmentId"::text AND
             a."metadata"->>'fromRevision' = OLD."revision"::text AND
             a."metadata"->'newReceipt'->>'grade' = 'frontier' AND
             a."metadata"->'newReceipt'->>'role' = OLD."taskRole" AND
             a."metadata"->'newReceipt'->>'receiptDigest' ~ '^[a-f0-9]{64}$' AND
             a."metadata"->>'originalReceiptDigest' =
               d."confirmationSnapshot" #>> '{card,task,costReceipt,receiptDigest}' AND
             d."confirmationSnapshot" #>> '{card,task,costReceipt,grade}' =
               OLD."executionGrade" AND
             d."confirmationSnapshot" #>> '{card,task,costReceipt,role}' =
               OLD."taskRole" AND
             e."taskId" = OLD."id" AND
             e."taskRevision" = OLD."revision" AND
             e."v22AssignmentId" = OLD."v22AssignmentId" AND
             e."endedAt" IS NULL
         ) OR
         (SELECT count(*) FROM "AdminAuditLog" a
           WHERE a."action" = 'amux.grade.escalated' AND
             a."targetType" = 'AmuxWorkItem' AND
             a."targetId" = OLD."id") <> 1 THEN
        RAISE EXCEPTION 'AMUX v4 Task approval binding is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'AmuxV4TaskDag_binding_check';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
