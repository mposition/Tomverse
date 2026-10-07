-- Linking a proposed Story/Task does not create or alter an existing card.
-- The consumed decision and its own approved draft are atomic at COMMIT.
-- baseline-check: present-if-function "amux_v4_card_link_consistency_guard"
CREATE FUNCTION amux_v4_card_link_consistency_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_decision "AmuxIdeaUnitDecision"%ROWTYPE;
  v_unit "AmuxIdeaDraftUnit"%ROWTYPE;
  v_card "AmuxWorkItem"%ROWTYPE;
  v_origin "AmuxIdeaUnitDecision"%ROWTYPE;
  v_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision" WHERE "id" = NEW."id";
  IF v_decision."state" IS DISTINCT FROM 'consumed' OR
     v_decision."action" IS DISTINCT FROM 'link_existing_card' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_unit FROM "AmuxIdeaDraftUnit"
    WHERE "id" = v_decision."draftUnitId";
  SELECT * INTO v_card FROM "AmuxWorkItem"
    WHERE "id" = v_decision."linkedWorkItemId";
  SELECT * INTO v_origin FROM "AmuxIdeaUnitDecision"
    WHERE "id" = v_card."v4SourceApprovalId";
  SELECT * INTO v_audit FROM "AdminAuditLog"
    WHERE "id" = v_decision."finalAuditLogId";
  IF v_unit."id" IS NULL OR v_unit."state" IS DISTINCT FROM 'approved' OR
     v_unit."unitKind" IS DISTINCT FROM 'card' OR
     v_unit."ideaId" IS DISTINCT FROM v_decision."ideaId" OR
     v_unit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_unit."bodyDigest" IS DISTINCT FROM v_decision."unitDigest" OR
     v_unit."bodyDigestKeyId" IS DISTINCT FROM v_decision."unitDigestKeyId" OR
     v_card."id" IS NULL OR
     v_card."id" IS DISTINCT FROM v_decision."baseWorkItemId" OR
     v_decision."linkedWorkItemId" IS DISTINCT FROM v_decision."baseWorkItemId" OR
     v_card."sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
     v_card."archivedAt" IS NOT NULL OR
     v_card."status" IS DISTINCT FROM
       v_decision."confirmationSnapshot"->'target'->>'status' OR
     v_card."revision" IS DISTINCT FROM v_decision."baseWorkItemRevision" OR
     v_card."v4TitleDigest" IS DISTINCT FROM v_decision."baseWorkItemDigest" OR
     v_card."v4TitleDigestKeyId" IS DISTINCT FROM v_decision."baseWorkItemDigestKeyId" OR
     v_card."cardType" IS DISTINCT FROM
       v_decision."confirmationSnapshot"->'target'->>'cardType' OR
     v_card."storyKind" IS DISTINCT FROM
       v_decision."confirmationSnapshot"->'target'->>'storyKind' OR
     v_card."parentFeatureNodeId" IS DISTINCT FROM
       v_decision."confirmationSnapshot"->'target'->>'featureNodeId' OR
     (v_decision."confirmationSnapshot"->'target'->>'revision')::integer IS DISTINCT FROM
       v_decision."baseWorkItemRevision" OR
     v_decision."confirmationSnapshot"->'target'->'content'->>'digest' IS DISTINCT FROM
       v_decision."baseWorkItemDigest" OR
     v_origin."action" IS DISTINCT FROM 'register_card' OR
     v_origin."state" IS DISTINCT FROM 'consumed' OR
     v_origin."registeredWorkItemId" IS DISTINCT FROM v_card."id" OR
     v_decision."confirmationSnapshot"->>'action' IS DISTINCT FROM 'link_existing_card' OR
     v_decision."confirmationSnapshot"->'target'->>'id' IS DISTINCT FROM v_card."id" OR
     v_decision."confirmationSnapshot"->'decisionReason'->>'digest' IS NULL OR
     v_audit."id" IS NULL OR
     v_audit."action" IS DISTINCT FROM 'amux.v4.unit.consume' OR
     v_audit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_audit."targetType" IS DISTINCT FROM 'AmuxIdeaUnitDecision' OR
     v_audit."targetId" IS DISTINCT FROM v_decision."id" OR
     v_audit."entryHash" IS NULL THEN
    RAISE EXCEPTION 'AMUX v4 card link is incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4CardLink_consistency_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amux_v4_linked_card_decision_complete
AFTER INSERT OR UPDATE ON "AmuxIdeaUnitDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."state" = 'consumed' AND NEW."action" = 'link_existing_card')
EXECUTE FUNCTION amux_v4_card_link_consistency_guard();
