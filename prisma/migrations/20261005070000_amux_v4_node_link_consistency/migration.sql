-- A consumed node selection/link is a metadata-only relationship. It must
-- finalize exactly its own proposal and bind an existing approved v4 target.
-- baseline-check: present-if-function "amux_v4_node_link_consistency_guard"
CREATE FUNCTION amux_v4_node_link_consistency_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_decision "AmuxIdeaUnitDecision"%ROWTYPE;
  v_unit "AmuxIdeaDraftUnit"%ROWTYPE;
  v_node "AmuxPortfolioNode"%ROWTYPE;
  v_revision "AmuxPortfolioNodeRevision"%ROWTYPE;
  v_origin "AmuxIdeaUnitDecision"%ROWTYPE;
  v_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision" WHERE "id" = NEW."id";
  IF v_decision."state" IS DISTINCT FROM 'consumed' OR
     v_decision."action" NOT IN ('select_existing_node', 'link_existing_node') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_unit FROM "AmuxIdeaDraftUnit"
    WHERE "id" = v_decision."draftUnitId";
  SELECT * INTO v_node FROM "AmuxPortfolioNode"
    WHERE "id" = v_decision."linkedNodeId";
  SELECT * INTO v_revision FROM "AmuxPortfolioNodeRevision"
    WHERE "nodeId" = v_decision."baseNodeId" AND
          "revision" = v_decision."baseNodeRevision";
  SELECT * INTO v_origin FROM "AmuxIdeaUnitDecision"
    WHERE "id" = v_revision."decisionId";
  SELECT * INTO v_audit FROM "AdminAuditLog"
    WHERE "id" = v_decision."finalAuditLogId";
  IF v_unit."id" IS NULL OR v_unit."state" IS DISTINCT FROM 'approved' OR
     v_unit."unitKind" IS DISTINCT FROM 'node' OR
     v_unit."ideaId" IS DISTINCT FROM v_decision."ideaId" OR
     v_unit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_unit."bodyDigest" IS DISTINCT FROM v_decision."unitDigest" OR
     v_unit."bodyDigestKeyId" IS DISTINCT FROM v_decision."unitDigestKeyId" OR
     v_node."id" IS NULL OR v_node."id" IS DISTINCT FROM v_decision."baseNodeId" OR
     v_decision."linkedNodeId" IS DISTINCT FROM v_decision."baseNodeId" OR
     v_node."state" IS DISTINCT FROM 'active' OR
     v_node."revision" IS DISTINCT FROM v_decision."baseNodeRevision" OR
     v_node."contentDigest" IS DISTINCT FROM v_decision."baseNodeDigest" OR
     v_node."contentDigestKeyId" IS DISTINCT FROM v_decision."baseNodeDigestKeyId" OR
     v_revision."id" IS NULL OR
     v_revision."contentDigest" IS DISTINCT FROM v_decision."baseNodeDigest" OR
     v_revision."contentDigestKeyId" IS DISTINCT FROM v_decision."baseNodeDigestKeyId" OR
     v_origin."action" IS DISTINCT FROM 'create_node' OR
     v_origin."state" IS DISTINCT FROM 'consumed' OR
     v_origin."resolvedNodeId" IS DISTINCT FROM v_node."id" OR
     v_decision."confirmationSnapshot"->'target'->>'id' IS DISTINCT FROM v_node."id" OR
     (v_decision."confirmationSnapshot"->'target'->>'revision')::integer IS DISTINCT FROM
       v_decision."baseNodeRevision" OR
     v_decision."confirmationSnapshot"->'target'->'content'->>'digest' IS DISTINCT FROM
       v_decision."baseNodeDigest" OR
     v_decision."confirmationSnapshot"->>'action' IS DISTINCT FROM v_decision."action" OR
     (v_decision."action" = 'link_existing_node' AND
       v_decision."confirmationSnapshot"->'decisionReason'->>'digest' IS NULL) OR
     (v_decision."action" = 'select_existing_node' AND
       v_decision."confirmationSnapshot"->'decisionReason' IS DISTINCT FROM 'null'::jsonb) OR
     v_audit."id" IS NULL OR
     v_audit."action" IS DISTINCT FROM 'amux.v4.unit.consume' OR
     v_audit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_audit."targetType" IS DISTINCT FROM 'AmuxIdeaUnitDecision' OR
     v_audit."targetId" IS DISTINCT FROM v_decision."id" OR
     v_audit."entryHash" IS NULL THEN
    RAISE EXCEPTION 'AMUX v4 node link is incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4NodeLink_consistency_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amux_v4_linked_node_decision_complete
AFTER INSERT OR UPDATE ON "AmuxIdeaUnitDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."state" = 'consumed' AND
  NEW."action" IN ('select_existing_node', 'link_existing_node'))
EXECUTE FUNCTION amux_v4_node_link_consistency_guard();
