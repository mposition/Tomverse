-- One consumed owner decision, its approved draft and its newly created
-- backlog card or hierarchy node must be complete at COMMIT. The application
-- intentionally inserts the target before consuming the decision, so this
-- check is deferred. Historical non-v4 cards are outside its scope.
-- baseline-check: present-if-function "amux_v4_registration_consistency_guard"
CREATE FUNCTION amux_v4_registration_consistency_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_decision "AmuxIdeaUnitDecision"%ROWTYPE;
  v_unit "AmuxIdeaDraftUnit"%ROWTYPE;
  v_card "AmuxWorkItem"%ROWTYPE;
  v_node "AmuxPortfolioNode"%ROWTYPE;
  v_revision "AmuxPortfolioNodeRevision"%ROWTYPE;
  v_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'AmuxIdeaUnitDecision' THEN
    SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision" WHERE "id" = NEW."id";
  ELSIF TG_TABLE_NAME = 'AmuxWorkItem' THEN
    IF NEW."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' THEN
      RETURN NEW;
    END IF;
    SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision"
      WHERE "id" = NEW."v4SourceApprovalId";
  ELSIF TG_TABLE_NAME = 'AmuxPortfolioNode' THEN
    SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision"
      WHERE "resolvedNodeId" = NEW."id" AND "action" = 'create_node';
  ELSE
    SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision"
      WHERE "id" = NEW."decisionId" AND "action" = 'create_node';
  END IF;

  IF v_decision."id" IS NULL THEN
    IF TG_TABLE_NAME = 'AmuxIdeaUnitDecision' AND
       NEW."state" IS DISTINCT FROM 'consumed' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AMUX v4 registration decision is missing'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4Registration_consistency_check';
  END IF;
  IF TG_TABLE_NAME = 'AmuxIdeaUnitDecision' AND
     v_decision."state" IS DISTINCT FROM 'consumed' THEN
    RETURN NEW;
  END IF;
  IF v_decision."state" IS DISTINCT FROM 'consumed' OR
     v_decision."action" NOT IN ('register_card', 'create_node') THEN
    RAISE EXCEPTION 'AMUX v4 registration decision is not consumed'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4Registration_consistency_check';
  END IF;
  SELECT * INTO v_unit FROM "AmuxIdeaDraftUnit"
    WHERE "id" = v_decision."draftUnitId";
  SELECT * INTO v_audit FROM "AdminAuditLog"
    WHERE "id" = v_decision."finalAuditLogId";
  IF v_unit."id" IS NULL OR v_unit."state" IS DISTINCT FROM 'approved' OR
     v_unit."ideaId" IS DISTINCT FROM v_decision."ideaId" OR
     v_unit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_unit."bodyDigest" IS DISTINCT FROM v_decision."unitDigest" OR
     v_unit."bodyDigestKeyId" IS DISTINCT FROM v_decision."unitDigestKeyId" OR
     v_audit."id" IS NULL OR
     v_audit."action" IS DISTINCT FROM 'amux.v4.unit.consume' OR
     v_audit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_audit."targetType" IS DISTINCT FROM 'AmuxIdeaUnitDecision' OR
     v_audit."targetId" IS DISTINCT FROM v_decision."id" OR
     v_audit."entryHash" IS NULL THEN
    RAISE EXCEPTION 'AMUX v4 registration draft or audit is incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4Registration_consistency_check';
  END IF;

  IF v_decision."action" = 'register_card' THEN
    IF v_unit."unitKind" IS DISTINCT FROM 'card' OR
       v_decision."resolvedNodeId" IS NOT NULL OR
       v_decision."registeredWorkItemId" IS NULL THEN
      RAISE EXCEPTION 'AMUX v4 card decision shape is invalid'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4Registration_consistency_check';
    END IF;
    SELECT * INTO v_card FROM "AmuxWorkItem"
      WHERE "id" = v_decision."registeredWorkItemId";
    IF v_card."id" IS NULL OR
       v_card."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
       v_card."sourceKey" IS DISTINCT FROM upper(v_unit."id") OR
       v_card."sourceDigest" IS DISTINCT FROM v_unit."bodyDigest" OR
       v_card."v4SourceApprovalId" IS DISTINCT FROM v_decision."id" OR
       v_card."sourceSnapshot"->>'ideaId' IS DISTINCT FROM v_decision."ideaId" OR
       v_card."sourceSnapshot"->>'approvalId' IS DISTINCT FROM v_decision."id" THEN
      RAISE EXCEPTION 'AMUX v4 card is not bound to its owner decision'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4Registration_consistency_check';
    END IF;
    IF TG_TABLE_NAME = 'AmuxIdeaUnitDecision' AND
       (v_card."status" IS DISTINCT FROM 'backlog' OR
        v_card."owner" IS NOT NULL OR v_card."claimedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'AMUX v4 registration cannot start work'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4Registration_consistency_check';
    END IF;
  ELSE
    IF v_unit."unitKind" IS DISTINCT FROM 'node' OR
       v_decision."registeredWorkItemId" IS NOT NULL OR
       v_decision."resolvedNodeId" IS NULL THEN
      RAISE EXCEPTION 'AMUX v4 node decision shape is invalid'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4Registration_consistency_check';
    END IF;
    SELECT * INTO v_node FROM "AmuxPortfolioNode"
      WHERE "id" = v_decision."resolvedNodeId";
    SELECT * INTO v_revision FROM "AmuxPortfolioNodeRevision"
      WHERE "nodeId" = v_decision."resolvedNodeId" AND "revision" = 0;
    IF v_node."id" IS NULL OR v_revision."id" IS NULL OR
       v_node."approvedByUserId" IS DISTINCT FROM v_decision."actorUserId" OR
       v_node."authorizationAuditLogId" IS DISTINCT FROM v_audit."id" OR
       v_revision."decisionId" IS DISTINCT FROM v_decision."id" OR
       v_revision."authorizationAuditLogId" IS DISTINCT FROM v_audit."id" OR
       v_revision."contentDigest" IS DISTINCT FROM v_node."contentDigest" OR
       v_revision."contentDigestKeyId" IS DISTINCT FROM v_node."contentDigestKeyId" OR
       v_node."level" IS DISTINCT FROM
         v_decision."confirmationSnapshot" #>> '{nodeProposal,level}' OR
       v_node."parentId" IS DISTINCT FROM
         v_decision."confirmationSnapshot" #>> '{nodeProposal,parentId}' THEN
      RAISE EXCEPTION 'AMUX v4 node is not bound to its owner decision'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxV4Registration_consistency_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amux_v4_consumed_decision_complete
AFTER INSERT OR UPDATE ON "AmuxIdeaUnitDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."state" = 'consumed' AND
  NEW."action" IN ('register_card', 'create_node'))
EXECUTE FUNCTION amux_v4_registration_consistency_guard();

CREATE CONSTRAINT TRIGGER amux_v4_registered_card_complete
AFTER INSERT ON "AmuxWorkItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."sourceSystem" = 'admin-idea-v4')
EXECUTE FUNCTION amux_v4_registration_consistency_guard();
