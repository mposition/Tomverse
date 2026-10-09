-- Permit one append-only replacement after deployment drift. The first stage
-- and its 80 unconsumed slots remain as a closed, audited historical fact.
ALTER TABLE "PromptRefinerVnextOneShotStage"
    DROP CONSTRAINT "PromptRefinerVnextOneShotStage_id_check";
ALTER TABLE "PromptRefinerVnextOneShotStage"
    ADD CONSTRAINT "PromptRefinerVnextOneShotStage_id_check"
    CHECK ("id" IN (
        'prompt-refiner-vnext-one-shot-v1',
        'prompt-refiner-vnext-one-shot-v2'
    ));

ALTER TABLE "PromptRefinerVnextOneShotStage"
    ADD COLUMN "supersededAuditLogId" TEXT;
CREATE UNIQUE INDEX "PromptRefinerVnextOneShotStage_supersededAuditLogId_key"
    ON "PromptRefinerVnextOneShotStage"("supersededAuditLogId");

-- The old stage can record this link only as part of its one-way close.
-- Other stage transitions cannot forge, change, or remove it.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_supersession_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    linked_audit RECORD;
    observed_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."supersededAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'one-shot stage cannot start with a supersession audit';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF OLD."id" = 'prompt-refiner-vnext-one-shot-v1' AND
       OLD."status" = 'staged' AND NEW."status" = 'closed' AND
       NEW."supersededAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'one-shot first-stage close requires a supersession audit';
    END IF;
    IF NEW."supersededAuditLogId" IS NOT DISTINCT FROM OLD."supersededAuditLogId" THEN
        RETURN NEW;
    END IF;
    IF OLD."id" <> 'prompt-refiner-vnext-one-shot-v1' OR
       OLD."status" <> 'staged' OR NEW."status" <> 'closed' OR
       OLD."supersededAuditLogId" IS NOT NULL OR
       NEW."supersededAuditLogId" IS NULL OR
       OLD."runApprovalAuditLogId" IS NOT NULL THEN
        RAISE EXCEPTION 'one-shot supersession audit transition is invalid';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "actorUserId", "action", "targetType", "targetId",'
        || ' "metadata", "entryHash", "createdAt" FROM %I."AdminAuditLog"'
        || ' WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
    ) INTO linked_audit USING NEW."supersededAuditLogId";
    observed_at := clock_timestamp() AT TIME ZONE 'UTC';
    IF linked_audit."actorUserId" IS DISTINCT FROM OLD."approvedBy" OR
       linked_audit."action" IS DISTINCT FROM 'prompt_refiner.vnext_one_shot.stage_superseded' OR
       linked_audit."targetType" IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
       linked_audit."targetId" IS DISTINCT FROM OLD."id" OR
       linked_audit."entryHash" IS NULL OR
       linked_audit."entryHash" !~ '^[a-f0-9]{64}$' OR
       linked_audit."createdAt" < observed_at - INTERVAL '1 minute' OR
       linked_audit."createdAt" > observed_at + INTERVAL '1 minute' OR
       linked_audit."metadata" ->> 'replacementStageId' IS DISTINCT FROM
         'prompt-refiner-vnext-one-shot-v2' OR
       linked_audit."metadata" ->> 'previousStageApprovalAuditLogId' IS DISTINCT FROM
         OLD."stageApprovalAuditLogId" OR
       coalesce(linked_audit."metadata" ->> 'replacementStageApprovalAuditLogId', '') = '' THEN
        RAISE EXCEPTION 'one-shot supersession audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_supersession_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_supersession_guard"();

CREATE FUNCTION "prompt_refiner_vnext_one_shot_replacement_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    previous_stage RECORD;
    linked_audit RECORD;
    previous_slots BIGINT;
    previous_consumed BIGINT;
BEGIN
    IF NEW."id" <> 'prompt-refiner-vnext-one-shot-v2' THEN
        RETURN NEW;
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT *'
        || ' FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v1'''
        || ' FOR NO KEY UPDATE', TG_TABLE_SCHEMA
    ) INTO previous_stage;
    IF previous_stage."status" IS DISTINCT FROM 'closed' OR
       previous_stage."runApprovalAuditLogId" IS NOT NULL OR
       previous_stage."supersededAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'one-shot replacement requires a closed, unrun first stage';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "actorUserId", "action", "targetId", "metadata", "entryHash"'
        || ' FROM %I."AdminAuditLog" WHERE "id" = $1 FOR KEY SHARE',
        TG_TABLE_SCHEMA
    ) INTO linked_audit USING previous_stage."supersededAuditLogId";
    IF linked_audit."actorUserId" IS DISTINCT FROM NEW."approvedBy" OR
       linked_audit."action" IS DISTINCT FROM 'prompt_refiner.vnext_one_shot.stage_superseded' OR
       linked_audit."targetId" IS DISTINCT FROM previous_stage."id" OR
       linked_audit."entryHash" IS NULL OR
       linked_audit."metadata" ->> 'replacementStageId' IS DISTINCT FROM NEW."id" OR
       linked_audit."metadata" ->> 'replacementStageApprovalAuditLogId' IS DISTINCT FROM
         NEW."stageApprovalAuditLogId" OR
       linked_audit."metadata" ->> 'previousStageApprovalAuditLogId' IS DISTINCT FROM
         previous_stage."stageApprovalAuditLogId" OR
       NEW."approvedBy" IS DISTINCT FROM previous_stage."approvedBy" OR
       NEW."sourceCommitSha" IS DISTINCT FROM previous_stage."sourceCommitSha" OR
       NEW."sourceManifestDigest" IS DISTINCT FROM previous_stage."sourceManifestDigest" OR
       NEW."runnerDigest" IS DISTINCT FROM previous_stage."runnerDigest" OR
       NEW."manifestRoot" IS DISTINCT FROM previous_stage."manifestRoot" OR
       NEW."pricePinDigest" IS DISTINCT FROM previous_stage."pricePinDigest" OR
       NEW."perRequestCostMicroUsd" IS DISTINCT FROM previous_stage."perRequestCostMicroUsd" OR
       NEW."slotCount" IS DISTINCT FROM previous_stage."slotCount" OR
       NEW."costCeilingMicroUsd" IS DISTINCT FROM previous_stage."costCeilingMicroUsd" OR
       NEW."runtimeDeploymentId" IS NOT DISTINCT FROM previous_stage."runtimeDeploymentId" THEN
        RAISE EXCEPTION 'one-shot replacement does not match the first-stage binding';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed'')'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v1''',
        TG_TABLE_SCHEMA
    ) INTO previous_slots, previous_consumed;
    IF previous_slots <> 80 OR previous_consumed <> 0 THEN
        RAISE EXCEPTION 'one-shot replacement requires 80 unconsumed first-stage slots';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_refiner_vnext_one_shot_replacement_guard_trigger"
BEFORE INSERT ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_replacement_guard"();

-- A close carrying a replacement audit cannot commit on its own. This
-- constraint is deferred so the app can close v1 and then insert v2
-- inside the same transaction, while never persisting a
-- closed v1 with no replacement stage.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_replacement_complete"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    replacement_count BIGINT;
BEGIN
    IF OLD."id" <> 'prompt-refiner-vnext-one-shot-v1' OR
       OLD."status" <> 'staged' OR NEW."status" <> 'closed' OR
       NEW."supersededAuditLogId" IS NULL THEN
        RETURN NEW;
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v2'''
        || ' AND "status" = ''staged''', TG_TABLE_SCHEMA
    ) INTO replacement_count;
    IF replacement_count <> 1 THEN
        RAISE EXCEPTION 'one-shot supersession requires replacement stage in the same transaction';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "prompt_refiner_vnext_one_shot_replacement_complete_trigger"
AFTER UPDATE ON "PromptRefinerVnextOneShotStage"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_replacement_complete"();
