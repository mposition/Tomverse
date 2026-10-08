-- A09 owner-authored split/merge lineage. This schema does not open the v4
-- registration latch or create any execution/worker state.
CREATE TABLE "AmuxIdeaDerivationGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestId" UUID NOT NULL UNIQUE,
    "operation" TEXT NOT NULL,
    "sourceCount" INTEGER NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "confirmationDigest" TEXT NOT NULL,
    "confirmationDigestKeyId" TEXT NOT NULL,
    "reasonDigest" TEXT NOT NULL,
    "reasonDigestKeyId" TEXT NOT NULL,
    "approvalAuditLogId" TEXT NOT NULL UNIQUE,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AmuxIdeaDerivationGroup_idea_fkey" FOREIGN KEY ("ideaId", "actorUserId")
      REFERENCES "AmuxIdeaSubmission"("id", "actorUserId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaDerivationGroup_audit_fkey" FOREIGN KEY ("approvalAuditLogId")
      REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaDerivationGroup_shape_check" CHECK (
      "operation" IN ('split', 'merge') AND
      (("operation" = 'split' AND "sourceCount" = 1 AND "targetCount" >= 2) OR
       ("operation" = 'merge' AND "sourceCount" >= 2 AND "targetCount" = 1)) AND
      "sourceCount" <= 40 AND "targetCount" <= 40 AND
      "confirmationDigest" ~ '^[a-f0-9]{64}$' AND
      "reasonDigest" ~ '^[a-f0-9]{64}$'
    )
);
CREATE INDEX "AmuxIdeaDerivationGroup_idea_actor_idx"
    ON "AmuxIdeaDerivationGroup"("ideaId", "actorUserId");

ALTER TABLE "AmuxIdeaDraftUnit" ADD COLUMN "derivationGroupId" TEXT;
ALTER TABLE "AmuxIdeaDraftUnit" ADD CONSTRAINT "AmuxIdeaDraftUnit_derivation_group_fkey"
  FOREIGN KEY ("derivationGroupId") REFERENCES "AmuxIdeaDerivationGroup"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxIdeaDerivationEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "sourceUnitId" TEXT NOT NULL,
    "targetUnitId" TEXT NOT NULL,
    CONSTRAINT "AmuxIdeaDerivationEdge_group_fkey" FOREIGN KEY ("groupId")
      REFERENCES "AmuxIdeaDerivationGroup"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaDerivationEdge_source_fkey" FOREIGN KEY ("sourceUnitId")
      REFERENCES "AmuxIdeaDraftUnit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaDerivationEdge_target_fkey" FOREIGN KEY ("targetUnitId")
      REFERENCES "AmuxIdeaDraftUnit"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaDerivationEdge_distinct_check" CHECK ("sourceUnitId" <> "targetUnitId"),
    CONSTRAINT "AmuxIdeaDerivationEdge_tuple_key" UNIQUE ("groupId", "sourceUnitId", "targetUnitId")
);
CREATE INDEX "AmuxIdeaDerivationEdge_target_idx" ON "AmuxIdeaDerivationEdge"("targetUnitId");

-- Every new draft, whether from a later model page or owner derivation, uses
-- the FIRST completed chunk's +30d clock. A later page cannot reset it.
CREATE FUNCTION amux_v4_draft_first_expiry_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE first_completed timestamp(3);
BEGIN
  SELECT "analysisCompletedAt" INTO first_completed FROM public."AmuxIdeaAnalysisChunk"
   WHERE "ideaId" = NEW."ideaId" AND "chunkIndex" = 0 FOR SHARE;
  IF first_completed IS NULL OR
     (clock_timestamp() AT TIME ZONE 'UTC') >= first_completed + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'first analysis clock expired or missing'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_first_expiry_check';
  END IF;
  NEW."expiresAt" := first_completed + INTERVAL '30 days';
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaDraftUnit_z_first_expiry_guard"
  BEFORE INSERT ON "AmuxIdeaDraftUnit" FOR EACH ROW
  EXECUTE FUNCTION amux_v4_draft_first_expiry_guard();

CREATE FUNCTION amux_v4_derivation_group_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE audit_actor text; audit_action text; audit_target_type text;
        audit_target_id text; audit_hash text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'derivation group is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationGroup_immutable_check';
  END IF;
  SELECT "actorUserId", "action", "targetType", "targetId", "entryHash"
    INTO audit_actor, audit_action, audit_target_type, audit_target_id, audit_hash
    FROM public."AdminAuditLog" WHERE "id" = NEW."approvalAuditLogId" FOR SHARE;
  IF audit_actor IS DISTINCT FROM NEW."actorUserId" OR
     audit_action IS DISTINCT FROM 'amux.v4.derivation.approve' OR
     audit_target_type IS DISTINCT FROM 'AmuxIdeaDerivationGroup' OR
     audit_target_id IS DISTINCT FROM NEW."id" OR
     audit_hash IS NULL OR audit_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'derivation group requires exact owner audit'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationGroup_audit_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaDerivationGroup_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaDerivationGroup"
  FOR EACH ROW EXECUTE FUNCTION amux_v4_derivation_group_guard();

CREATE FUNCTION amux_v4_draft_derivation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE group_idea text; group_actor text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."derivationGroupId" IS DISTINCT FROM OLD."derivationGroupId" THEN
      RAISE EXCEPTION 'draft derivation identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_derivation_immutable_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."derivationGroupId" IS NOT NULL THEN
    SELECT "ideaId", "actorUserId" INTO group_idea, group_actor
      FROM public."AmuxIdeaDerivationGroup"
      WHERE "id" = NEW."derivationGroupId" FOR SHARE;
    IF NEW."unitKind" <> 'card' OR group_idea IS DISTINCT FROM NEW."ideaId" OR
       group_actor IS DISTINCT FROM NEW."actorUserId" THEN
      RAISE EXCEPTION 'derived unit must belong to approved owner group'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_derivation_group_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaDraftUnit_derivation_guard"
  BEFORE INSERT OR UPDATE ON "AmuxIdeaDraftUnit" FOR EACH ROW
  EXECUTE FUNCTION amux_v4_draft_derivation_guard();

CREATE FUNCTION amux_v4_derivation_edge_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE group_idea text; group_actor text; source_idea text; source_actor text;
        target_idea text; target_actor text; target_group text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'derivation edge is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationEdge_immutable_check';
  END IF;
  SELECT "ideaId", "actorUserId" INTO group_idea, group_actor
    FROM public."AmuxIdeaDerivationGroup" WHERE "id" = NEW."groupId" FOR SHARE;
  SELECT "ideaId", "actorUserId" INTO source_idea, source_actor
    FROM public."AmuxIdeaDraftUnit" WHERE "id" = NEW."sourceUnitId" FOR SHARE;
  SELECT "ideaId", "actorUserId", "derivationGroupId"
    INTO target_idea, target_actor, target_group
    FROM public."AmuxIdeaDraftUnit" WHERE "id" = NEW."targetUnitId" FOR SHARE;
  IF group_idea IS NULL OR source_idea IS DISTINCT FROM group_idea OR
     target_idea IS DISTINCT FROM group_idea OR
     source_actor IS DISTINCT FROM group_actor OR
     target_actor IS DISTINCT FROM group_actor OR
     target_group IS DISTINCT FROM NEW."groupId" THEN
    RAISE EXCEPTION 'derivation edge crosses owner or group'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationEdge_boundary_check';
  END IF;
  IF EXISTS (SELECT 1 FROM public."AmuxIdeaUnitDecision"
              WHERE "draftUnitId" = NEW."sourceUnitId" AND "state" = 'prepared') THEN
    RAISE EXCEPTION 'source has an active unit decision'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationEdge_active_decision_check';
  END IF;
  IF EXISTS (SELECT 1 FROM public."AmuxIdeaDerivationEdge"
              WHERE "sourceUnitId" = NEW."sourceUnitId"
                AND "groupId" <> NEW."groupId") THEN
    RAISE EXCEPTION 'derivation source already has a descendant group'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationEdge_source_once_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaDerivationEdge_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaDerivationEdge"
  FOR EACH ROW EXECUTE FUNCTION amux_v4_derivation_edge_guard();

CREATE FUNCTION amux_v4_derivation_group_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sources integer; targets integer; edges integer;
        group_id text; expected_sources integer; expected_targets integer;
BEGIN
  IF TG_TABLE_NAME = 'AmuxIdeaDerivationEdge' THEN
    group_id := NEW."groupId";
  ELSE
    group_id := NEW."id";
  END IF;
  SELECT "sourceCount", "targetCount" INTO expected_sources, expected_targets
    FROM public."AmuxIdeaDerivationGroup" WHERE "id" = group_id;
  SELECT COUNT(DISTINCT "sourceUnitId"), COUNT(DISTINCT "targetUnitId"), COUNT(*)
    INTO sources, targets, edges FROM public."AmuxIdeaDerivationEdge"
   WHERE "groupId" = group_id;
  IF expected_sources IS NULL OR sources <> expected_sources OR
     targets <> expected_targets OR edges <> expected_sources * expected_targets THEN
    RAISE EXCEPTION 'derivation group missing a complete edge set'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivationGroup_edges_complete_check';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "AmuxIdeaDerivationGroup_edges_complete"
  AFTER INSERT ON "AmuxIdeaDerivationGroup" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v4_derivation_group_complete();
CREATE CONSTRAINT TRIGGER "AmuxIdeaDerivationEdge_group_complete"
  AFTER INSERT ON "AmuxIdeaDerivationEdge" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION amux_v4_derivation_group_complete();

CREATE FUNCTION amux_v4_derived_decision_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE group_id text;
BEGIN
  IF EXISTS (SELECT 1 FROM public."AmuxIdeaDerivationEdge"
              WHERE "sourceUnitId" = NEW."draftUnitId") THEN
    RAISE EXCEPTION 'derivation source cannot receive another decision'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_derived_source_check';
  END IF;
  SELECT "derivationGroupId" INTO group_id FROM public."AmuxIdeaDraftUnit"
    WHERE "id" = NEW."draftUnitId" FOR SHARE;
  IF group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."AmuxIdeaDerivationEdge" e
     WHERE e."groupId" = group_id AND e."targetUnitId" = NEW."draftUnitId"
  ) THEN
    RAISE EXCEPTION 'derived proposal has no approved lineage'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_derivation_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaUnitDecision_derived_guard"
  BEFORE INSERT ON "AmuxIdeaUnitDecision" FOR EACH ROW
  EXECUTE FUNCTION amux_v4_derived_decision_guard();

CREATE FUNCTION amux_v4_derivation_no_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'derivation history cannot be truncated'
    USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDerivation_no_truncate_check';
END;
$$;
CREATE TRIGGER "AmuxIdeaDerivationGroup_no_truncate"
  BEFORE TRUNCATE ON "AmuxIdeaDerivationGroup"
  FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_derivation_no_truncate();
CREATE TRIGGER "AmuxIdeaDerivationEdge_no_truncate"
  BEFORE TRUNCATE ON "AmuxIdeaDerivationEdge"
  FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_derivation_no_truncate();
