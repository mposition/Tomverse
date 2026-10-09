-- A consumed reject decision must finalize only its own draft at COMMIT.
-- The app updates both rows in one transaction, so the check is deferred.
-- baseline-check: present-if-function "amux_v4_rejection_consistency_guard"
CREATE FUNCTION amux_v4_rejection_consistency_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_decision "AmuxIdeaUnitDecision"%ROWTYPE;
  v_unit "AmuxIdeaDraftUnit"%ROWTYPE;
  v_audit "AdminAuditLog"%ROWTYPE;
BEGIN
  SELECT * INTO v_decision FROM "AmuxIdeaUnitDecision" WHERE "id" = NEW."id";
  IF v_decision."state" IS DISTINCT FROM 'consumed' OR
     v_decision."action" IS DISTINCT FROM 'reject_unit' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_unit FROM "AmuxIdeaDraftUnit"
    WHERE "id" = v_decision."draftUnitId";
  SELECT * INTO v_audit FROM "AdminAuditLog"
    WHERE "id" = v_decision."finalAuditLogId";
  IF v_unit."id" IS NULL OR v_unit."state" IS DISTINCT FROM 'rejected' OR
     v_unit."ideaId" IS DISTINCT FROM v_decision."ideaId" OR
     v_unit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_unit."bodyDigest" IS DISTINCT FROM v_decision."unitDigest" OR
     v_unit."bodyDigestKeyId" IS DISTINCT FROM v_decision."unitDigestKeyId" OR
     v_decision."confirmationSnapshot"->>'action' IS DISTINCT FROM 'reject_unit' OR
     v_decision."confirmationSnapshot"->'decisionReason'->>'digest' IS NULL OR
     v_audit."id" IS NULL OR
     v_audit."action" IS DISTINCT FROM 'amux.v4.unit.consume' OR
     v_audit."actorUserId" IS DISTINCT FROM v_decision."actorUserId" OR
     v_audit."targetType" IS DISTINCT FROM 'AmuxIdeaUnitDecision' OR
     v_audit."targetId" IS DISTINCT FROM v_decision."id" OR
     v_audit."entryHash" IS NULL THEN
    RAISE EXCEPTION 'AMUX v4 rejection is incomplete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxV4Rejection_consistency_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amux_v4_rejected_decision_complete
AFTER INSERT OR UPDATE ON "AmuxIdeaUnitDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."state" = 'consumed' AND NEW."action" = 'reject_unit')
EXECUTE FUNCTION amux_v4_rejection_consistency_guard();
