-- Owner decision 2026-10-30: a test Task runs as an implement execution and
-- leaves a patch, so the unattended registrar gives it the same default public
-- pull request consent as an implement Task (amux-intake.md v19 item 5). The
-- system registration receipt guard counts that consent over implement and
-- test Tasks; its body changes only there. Production already holds this body:
-- it applied 20261031090000 before the function moved here, so the header
-- also names the body this migration writes.
-- baseline-check: replace-function-if-body-sha256 "amux_v19_system_registration_receipt_guard" "bb519a8550c1ffcd0f4d99b2d451a0515e282f95b23c9cb699f6d2e86e63c908" "dbeae5e141dca8fdde5517b7bd0838b49d089f2f491050baaab0c2794ed54437"
BEGIN;

CREATE OR REPLACE FUNCTION amux_v19_system_registration_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  audit_row record;
  scope_row record;
  metadata jsonb;
  unit_count integer;
  decision_count integer;
  node_count integer;
  card_count integer;
  assessment_count integer;
  score_count integer;
  implement_count integer;
BEGIN
  IF NEW."systemRegistrationAuditLogId" IS NOT DISTINCT FROM
      OLD."systemRegistrationAuditLogId" THEN
    RETURN NEW;
  END IF;
  IF OLD."systemRegistrationAuditLogId" IS NOT NULL OR
     NEW."systemRegistrationAuditLogId" IS NULL OR
     NEW."submissionOrigin" IS DISTINCT FROM 'session' OR
     OLD."state" IS DISTINCT FROM 'awaiting_owner' OR
     NEW."state" IS DISTINCT FROM 'completed' OR
     NEW."analysisCompletedAt" IS NULL OR
     NEW."currentSourcePlanRevisionId" IS NULL THEN
    RAISE EXCEPTION 'AMUX v19 system registration receipt transition invalid'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSubmission_system_registration_transition_check';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT a.*, a.xmin = pg_current_xact_id()::xid AS audit_same_transaction
    INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."systemRegistrationAuditLogId" FOR KEY SHARE;
  SELECT "id", "approvedByUserId", "approvalAuditLogId"
    INTO scope_row FROM "AmuxIdeaOperatingScopeSetting"
    WHERE "id" = NEW."sessionOperatingScopeSettingId" FOR KEY SHARE;
  metadata := audit_row."metadata";

  SELECT count(*) INTO unit_count FROM "AmuxIdeaDraftUnit"
    WHERE "ideaId" = NEW."id" AND "actorUserId" = NEW."actorUserId" AND
      "derivationGroupId" IS NULL AND "unitKind" IN ('node', 'card');
  SELECT count(*) INTO decision_count FROM "AmuxIdeaUnitDecision"
    WHERE "ideaId" = NEW."id" AND "actorUserId" = NEW."actorUserId" AND
      "state" = 'consumed';
  SELECT count(*) INTO node_count FROM "AmuxIdeaUnitDecision"
    WHERE "ideaId" = NEW."id" AND "actorUserId" = NEW."actorUserId" AND
      "state" = 'consumed' AND "action" = 'create_node' AND
      "resolvedNodeId" IS NOT NULL;
  SELECT count(*) INTO card_count FROM "AmuxIdeaUnitDecision"
    WHERE "ideaId" = NEW."id" AND "actorUserId" = NEW."actorUserId" AND
      "state" = 'consumed' AND "action" = 'register_card' AND
      "registeredWorkItemId" IS NOT NULL;
  SELECT count(*) INTO assessment_count FROM "AmuxPortfolioAssessment" a
    WHERE a."approvedByUserId" = NEW."actorUserId" AND
      (a."nodeId" IN (SELECT d."resolvedNodeId" FROM "AmuxIdeaUnitDecision" d
        WHERE d."ideaId" = NEW."id" AND d."state" = 'consumed') OR
       a."cardId" IN (SELECT d."registeredWorkItemId" FROM "AmuxIdeaUnitDecision" d
        WHERE d."ideaId" = NEW."id" AND d."state" = 'consumed'));
  SELECT count(*) INTO score_count FROM "AmuxPortfolioScoreSnapshot" s
    WHERE s."taskId" IN (SELECT d."registeredWorkItemId"
      FROM "AmuxIdeaUnitDecision" d WHERE d."ideaId" = NEW."id" AND
        d."state" = 'consumed');
  SELECT count(*) INTO implement_count FROM "AmuxIdeaUnitDecision" d
    WHERE d."ideaId" = NEW."id" AND d."state" = 'consumed' AND
      d."confirmationSnapshot"->'card'->'task'->>'role' IN ('implement', 'test');

  IF audit_row."id" IS NULL OR audit_row.audit_same_transaction IS NOT TRUE OR
     audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL OR
     audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" IS DISTINCT FROM 'amux.v19.plan.auto_registered' OR
     audit_row."targetType" IS DISTINCT FROM 'AmuxIdeaSubmission' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id" OR
     audit_row."summary" IS DISTINCT FROM
       'Registered one completed AMUX intake plan into inert backlog.' OR
     scope_row."id" IS NULL OR
     scope_row."approvedByUserId" IS DISTINCT FROM NEW."actorUserId" OR
     jsonb_typeof(metadata) IS DISTINCT FROM 'object' OR
     (metadata ?& ARRAY['systemActor', 'actorScope', 'ideaId',
       'sourcePlanRevisionId', 'operatingScopeSettingId',
       'operatingScopeApprovalAuditLogId',
       'nodeCount', 'cardCount', 'assessmentCount',
       'scoreCount', 'publicPrConsentCount', 'executionAttempted']) IS NOT TRUE OR
     metadata - ARRAY['systemActor', 'actorScope', 'ideaId',
       'sourcePlanRevisionId', 'operatingScopeSettingId',
       'operatingScopeApprovalAuditLogId',
       'nodeCount', 'cardCount', 'assessmentCount',
       'scoreCount', 'publicPrConsentCount', 'executionAttempted'] <> '{}'::jsonb OR
     metadata->>'systemActor' IS DISTINCT FROM 'amux-v4-intake' OR
     metadata->>'actorScope' IS DISTINCT FROM 'system-plan-registration-v1' OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."id" OR
     metadata->>'sourcePlanRevisionId' IS DISTINCT FROM NEW."currentSourcePlanRevisionId" OR
     metadata->>'operatingScopeSettingId' IS DISTINCT FROM scope_row."id" OR
     metadata->>'operatingScopeApprovalAuditLogId' IS DISTINCT FROM
       scope_row."approvalAuditLogId" OR
     jsonb_typeof(metadata->'nodeCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'cardCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'assessmentCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'scoreCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'publicPrConsentCount') IS DISTINCT FROM 'number' OR
     metadata->>'nodeCount' IS DISTINCT FROM node_count::text OR
     metadata->>'cardCount' IS DISTINCT FROM card_count::text OR
     metadata->>'assessmentCount' IS DISTINCT FROM assessment_count::text OR
     metadata->>'scoreCount' IS DISTINCT FROM score_count::text OR
     metadata->>'publicPrConsentCount' IS DISTINCT FROM implement_count::text OR
     metadata->'executionAttempted' IS DISTINCT FROM 'false'::jsonb OR
     unit_count = 0 OR decision_count <> unit_count OR
     node_count + card_count <> decision_count OR
     assessment_count <> decision_count OR score_count <> (
       SELECT count(*) FROM "AmuxIdeaUnitDecision" d WHERE d."ideaId" = NEW."id" AND
         d."state" = 'consumed' AND
         d."confirmationSnapshot"->'card'->>'cardType' = 'task') OR
     EXISTS (SELECT 1 FROM "AmuxIdeaDraftUnit" u WHERE u."ideaId" = NEW."id" AND
       u."actorUserId" = NEW."actorUserId" AND u."derivationGroupId" IS NULL AND
       u."unitKind" IN ('node', 'card') AND u."state" <> 'approved') OR
     EXISTS (SELECT 1 FROM "AmuxIdeaUnitDecision" d WHERE d."ideaId" = NEW."id" AND
       d."state" = 'consumed' AND
       d."confirmationSnapshot"->'registrationAuthority' IS DISTINCT FROM
         '{"kind":"system","systemActor":"amux-v4-intake","bindingVersion":"amux-v19-system-registration-v1"}'::jsonb) OR
     EXISTS (SELECT 1 FROM "AmuxIdeaRegistrationRefusal" r
       WHERE r."ideaId" = NEW."id" AND r."actorUserId" = NEW."actorUserId" AND
         r."state" = 'awaiting_operator' AND r."attemptKind" = 'whole_plan' AND
         r."sourcePlanRevisionId" = NEW."currentSourcePlanRevisionId") OR
     EXISTS (SELECT 1 FROM "AmuxIdeaUnitDecision" d WHERE d."ideaId" = NEW."id" AND
       d."state" = 'consumed' AND
       d."confirmationSnapshot"->'card'->'task'->>'role' IN ('implement', 'test') AND
       d."confirmationSnapshot"->'card'->'task'->'publicPrDisclosureApproved'
         IS DISTINCT FROM 'true'::jsonb) THEN
    RAISE EXCEPTION 'AMUX v19 system registration receipt evidence mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSubmission_system_registration_evidence_check';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
