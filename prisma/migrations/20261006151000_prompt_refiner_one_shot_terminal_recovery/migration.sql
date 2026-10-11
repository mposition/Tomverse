-- baseline-check: replace-function-if-body-sha256 "prompt_refiner_vnext_one_shot_supersession_guard" "7f15885fdcfa7a1d33ed496641b07ba25b720c11be1706b9d4c8970bda9eea95"
-- One exact v3 -> v4 recovery; historical stage, slot and audit rows stay intact.
ALTER TABLE "PromptRefinerVnextOneShotStage"
    DROP CONSTRAINT "PromptRefinerVnextOneShotStage_id_check";
ALTER TABLE "PromptRefinerVnextOneShotStage"
    ADD CONSTRAINT "PromptRefinerVnextOneShotStage_id_check"
    CHECK ("id" IN (
        'prompt-refiner-vnext-one-shot-v1',
        'prompt-refiner-vnext-one-shot-v2',
        'prompt-refiner-vnext-one-shot-v3',
        'prompt-refiner-vnext-one-shot-v4'
    ));

CREATE OR REPLACE FUNCTION "prompt_refiner_vnext_one_shot_supersession_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    linked_audit RECORD;
    observed_at TIMESTAMP(3);
    replacement_id TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."supersededAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'one-shot stage cannot start with a supersession audit';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF OLD."id" IN ('prompt-refiner-vnext-one-shot-v1',
                    'prompt-refiner-vnext-one-shot-v2',
                    'prompt-refiner-vnext-one-shot-v3') AND
       OLD."status" IN ('staged', 'run_approved') AND
       NEW."status" = 'closed' AND NEW."supersededAuditLogId" IS NULL THEN
        RAISE EXCEPTION 'one-shot stage close requires a supersession audit';
    END IF;
    IF NEW."supersededAuditLogId" IS NOT DISTINCT FROM OLD."supersededAuditLogId" THEN
        RETURN NEW;
    END IF;
    replacement_id := CASE OLD."id"
        WHEN 'prompt-refiner-vnext-one-shot-v1' THEN 'prompt-refiner-vnext-one-shot-v2'
        WHEN 'prompt-refiner-vnext-one-shot-v2' THEN 'prompt-refiner-vnext-one-shot-v3'
        WHEN 'prompt-refiner-vnext-one-shot-v3' THEN 'prompt-refiner-vnext-one-shot-v4'
        ELSE NULL END;
    IF replacement_id IS NULL OR NEW."status" <> 'closed' OR
       OLD."supersededAuditLogId" IS NOT NULL OR
       NEW."supersededAuditLogId" IS NULL OR
       (OLD."id" = 'prompt-refiner-vnext-one-shot-v1' AND
        (OLD."status" <> 'staged' OR OLD."runApprovalAuditLogId" IS NOT NULL)) OR
       (OLD."id" IN ('prompt-refiner-vnext-one-shot-v2',
                    'prompt-refiner-vnext-one-shot-v3') AND
        (OLD."status" <> 'run_approved' OR OLD."runApprovalAuditLogId" IS NULL OR
         NEW."runApprovalAuditLogId" IS DISTINCT FROM OLD."runApprovalAuditLogId")) THEN
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
       linked_audit."metadata" ->> 'replacementStageId' IS DISTINCT FROM replacement_id OR
       linked_audit."metadata" ->> 'previousStageApprovalAuditLogId' IS DISTINCT FROM
         OLD."stageApprovalAuditLogId" OR
       coalesce(linked_audit."metadata" ->> 'replacementStageApprovalAuditLogId', '') = '' OR
       (OLD."id" IN ('prompt-refiner-vnext-one-shot-v2',
                     'prompt-refiner-vnext-one-shot-v3') AND
        linked_audit."metadata" ->> 'previousRunApprovalAuditLogId' IS DISTINCT FROM
          OLD."runApprovalAuditLogId") OR
       (OLD."id" = 'prompt-refiner-vnext-one-shot-v3' AND
        coalesce(linked_audit."metadata" ->> 'previousShadowAuditLogId', '') = '') THEN
        RAISE EXCEPTION 'one-shot supersession audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "prompt_refiner_vnext_one_shot_v4_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    first_stage RECORD;
    second_stage RECORD;
    previous_stage RECORD;
    linked_audit RECORD;
    shadow_audit RECORD;
    first_slots BIGINT;
    first_consumed BIGINT;
    second_slots BIGINT;
    second_consumed BIGINT;
    previous_slots BIGINT;
    previous_consumed BIGINT;
    previous_wrong_ids BIGINT;
    shadow_count BIGINT;
    forbidden_audits BIGINT;
BEGIN
    IF NEW."id" <> 'prompt-refiner-vnext-one-shot-v4' THEN RETURN NEW; END IF;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v1'' FOR NO KEY UPDATE',
        TG_TABLE_SCHEMA
    ) INTO first_stage;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v2'' FOR NO KEY UPDATE',
        TG_TABLE_SCHEMA
    ) INTO second_stage;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v3'' FOR NO KEY UPDATE',
        TG_TABLE_SCHEMA
    ) INTO previous_stage;
    IF first_stage."status" IS DISTINCT FROM 'closed' OR
       first_stage."runApprovalAuditLogId" IS NOT NULL OR
       first_stage."supersededAuditLogId" IS NULL OR
       second_stage."status" IS DISTINCT FROM 'closed' OR
       second_stage."runApprovalAuditLogId" IS NULL OR
       second_stage."supersededAuditLogId" IS NULL OR
       previous_stage."status" IS DISTINCT FROM 'closed' OR
       previous_stage."runApprovalAuditLogId" IS NULL OR
       previous_stage."supersededAuditLogId" IS NULL OR
       previous_stage."runtimeDeploymentId" IS DISTINCT FROM
         '5e2245d9-17a8-46fe-b967-1ebd86806649' OR
       previous_stage."runtimeCommitSha" IS DISTINCT FROM
         '73e60ebd79869f16d82d914103122a0c3eaf0ad7' THEN
        RAISE EXCEPTION 'one-shot v4 recovery requires exact closed source';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "actorUserId", "action", "targetType", "targetId",'
        || ' "metadata", "entryHash" FROM %I."AdminAuditLog"'
        || ' WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
    ) INTO linked_audit USING previous_stage."supersededAuditLogId";
    IF linked_audit."actorUserId" IS DISTINCT FROM NEW."approvedBy" OR
       linked_audit."action" IS DISTINCT FROM 'prompt_refiner.vnext_one_shot.stage_superseded' OR
       linked_audit."targetType" IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
       linked_audit."targetId" IS DISTINCT FROM previous_stage."id" OR
       linked_audit."entryHash" IS NULL OR
       linked_audit."metadata" ->> 'replacementStageId' IS DISTINCT FROM NEW."id" OR
       linked_audit."metadata" ->> 'replacementStageApprovalAuditLogId' IS DISTINCT FROM
         NEW."stageApprovalAuditLogId" OR
       linked_audit."metadata" ->> 'previousStageApprovalAuditLogId' IS DISTINCT FROM
         previous_stage."stageApprovalAuditLogId" OR
       linked_audit."metadata" ->> 'previousRunApprovalAuditLogId' IS DISTINCT FROM
         previous_stage."runApprovalAuditLogId" OR
       coalesce(linked_audit."metadata" ->> 'previousShadowAuditLogId', '') = '' OR
       NEW."approvedBy" IS DISTINCT FROM previous_stage."approvedBy" OR
       NEW."sourceCommitSha" IS DISTINCT FROM previous_stage."sourceCommitSha" OR
       NEW."sourceManifestDigest" IS DISTINCT FROM previous_stage."sourceManifestDigest" OR
       NEW."runnerDigest" IS NOT DISTINCT FROM previous_stage."runnerDigest" OR
       NEW."manifestRoot" IS DISTINCT FROM previous_stage."manifestRoot" OR
       NEW."pricePinDigest" IS DISTINCT FROM previous_stage."pricePinDigest" OR
       NEW."perRequestCostMicroUsd" IS DISTINCT FROM previous_stage."perRequestCostMicroUsd" OR
       NEW."slotCount" IS DISTINCT FROM previous_stage."slotCount" OR
       NEW."costCeilingMicroUsd" IS DISTINCT FROM previous_stage."costCeilingMicroUsd" OR
       NEW."runtimeDeploymentId" IS NOT DISTINCT FROM previous_stage."runtimeDeploymentId" OR
       NEW."runtimeCommitSha" IS NOT DISTINCT FROM previous_stage."runtimeCommitSha" THEN
        RAISE EXCEPTION 'one-shot v4 recovery binding is invalid';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "action", "targetType", "targetId", "metadata", "entryHash"'
        || ' FROM %I."AdminAuditLog" WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
    ) INTO shadow_audit USING linked_audit."metadata" ->> 'previousShadowAuditLogId';
    IF shadow_audit."action" IS DISTINCT FROM
         'prompt_refiner.vnext_one_shot.operational_shadow_completed' OR
       shadow_audit."targetType" IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
       shadow_audit."targetId" IS DISTINCT FROM previous_stage."id" OR
       shadow_audit."entryHash" IS NULL OR
       shadow_audit."metadata" ->> 'runApprovalAuditLogId' IS DISTINCT FROM
         previous_stage."runApprovalAuditLogId" OR
       shadow_audit."metadata" ->> 'runnerDigest' IS DISTINCT FROM
         previous_stage."runnerDigest" OR
       shadow_audit."metadata" ->> 'runtimeDeploymentId' IS DISTINCT FROM
         previous_stage."runtimeDeploymentId" OR
       shadow_audit."metadata" ->> 'cacheWriteInputTokens' IS DISTINCT FROM '0' OR
       shadow_audit."metadata" ->> 'providerCalls' IS DISTINCT FROM '0' OR
       shadow_audit."metadata" ->> 'slotConsumeCalls' IS DISTINCT FROM '0' THEN
        RAISE EXCEPTION 'one-shot v4 recovery requires bound B06 shadow';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."AdminAuditLog" WHERE'
        || ' "action" = ''prompt_refiner.vnext_one_shot.operational_shadow_completed'''
        || ' AND "targetType" = ''PromptRefinerVnextOneShotStage'''
        || ' AND "targetId" = ''prompt-refiner-vnext-one-shot-v3''', TG_TABLE_SCHEMA
    ) INTO shadow_count;
    IF shadow_count <> 1 THEN
        RAISE EXCEPTION 'one-shot v4 recovery requires one B06 shadow';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed'')'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v1''', TG_TABLE_SCHEMA
    ) INTO first_slots, first_consumed;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed'')'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v2''', TG_TABLE_SCHEMA
    ) INTO second_slots, second_consumed;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed''),'
        || ' count(*) FILTER (WHERE "id" <> ''one-shot-v3-'' || "slotIndex"::text)'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v3''', TG_TABLE_SCHEMA
    ) INTO previous_slots, previous_consumed, previous_wrong_ids;
    IF first_slots <> 80 OR first_consumed <> 0 OR
       second_slots <> 80 OR second_consumed <> 0 OR
       previous_slots <> 80 OR previous_consumed <> 0 OR previous_wrong_ids <> 0 THEN
        RAISE EXCEPTION 'one-shot v4 recovery requires untouched historical slots';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."AdminAuditLog" WHERE '
        || '("targetType" = ''PromptRefinerVnextOneShotStage'' AND'
        || ' "targetId" = ''prompt-refiner-vnext-one-shot-v3'' AND'
        || ' "action" IN (''prompt_refiner.vnext_one_shot.outcome_unknown'','
        || ' ''prompt_refiner.vnext_one_shot.gate_evaluated'','
        || ' ''prompt_refiner.vnext_one_shot.disposition_recorded'','
        || ' ''prompt_refiner.vnext_one_shot.paid_dispatch_authorized'')) OR'
        || ' ("targetType" = ''PromptRefinerVnextOneShotSlot'' AND'
        || ' "targetId" LIKE ''one-shot-v3-%%'' AND'
        || ' "action" IN (''prompt_refiner.vnext_one_shot.slot_consumed'','
        || ' ''prompt_refiner.vnext_one_shot.terminal_recorded''))', TG_TABLE_SCHEMA
    ) INTO forbidden_audits;
    IF forbidden_audits <> 0 THEN
        RAISE EXCEPTION 'one-shot v4 recovery has forbidden historical evidence';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_v4_guard_trigger"
BEFORE INSERT ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v4_guard"();

-- A v3 close cannot commit without its one fresh v4 stage in the transaction.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_v4_complete"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE replacement_count BIGINT;
BEGIN
    IF OLD."id" <> 'prompt-refiner-vnext-one-shot-v3' OR
       OLD."status" <> 'run_approved' OR NEW."status" <> 'closed' OR
       NEW."supersededAuditLogId" IS NULL THEN RETURN NEW; END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v4'' AND "status" = ''staged''',
        TG_TABLE_SCHEMA
    ) INTO replacement_count;
    IF replacement_count <> 1 THEN
        RAISE EXCEPTION 'one-shot v3 close requires v4 in the same transaction';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "prompt_refiner_vnext_one_shot_v4_complete_trigger"
AFTER UPDATE ON "PromptRefinerVnextOneShotStage"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v4_complete"();
