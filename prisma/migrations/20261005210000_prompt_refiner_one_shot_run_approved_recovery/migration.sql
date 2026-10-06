-- baseline-check: replace-function-if-body-sha256 "prompt_refiner_vnext_one_shot_supersession_guard" "5f25bb1e215235540ff2aa46fbdd0d272ae10e2ab3ff62b4849238adef6613ea"
-- One exact v2 -> v3 recovery. Existing v1/v2 rows and slots remain historical.
ALTER TABLE "PromptRefinerVnextOneShotStage"
    DROP CONSTRAINT "PromptRefinerVnextOneShotStage_id_check";
ALTER TABLE "PromptRefinerVnextOneShotStage"
    ADD CONSTRAINT "PromptRefinerVnextOneShotStage_id_check"
    CHECK ("id" IN (
        'prompt-refiner-vnext-one-shot-v1',
        'prompt-refiner-vnext-one-shot-v2',
        'prompt-refiner-vnext-one-shot-v3'
    ));

-- The already-approved v2 may close only with its run audit intact and a
-- fresh, linked owner supersession audit. Preserve the v1 -> v2 rule.
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
                    'prompt-refiner-vnext-one-shot-v2') AND
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
        ELSE NULL END;
    IF replacement_id IS NULL OR NEW."status" <> 'closed' OR
       OLD."supersededAuditLogId" IS NOT NULL OR
       NEW."supersededAuditLogId" IS NULL OR
       (OLD."id" = 'prompt-refiner-vnext-one-shot-v1' AND
        (OLD."status" <> 'staged' OR OLD."runApprovalAuditLogId" IS NOT NULL)) OR
       (OLD."id" = 'prompt-refiner-vnext-one-shot-v2' AND
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
       (OLD."id" = 'prompt-refiner-vnext-one-shot-v2' AND
        linked_audit."metadata" ->> 'previousRunApprovalAuditLogId' IS DISTINCT FROM
          OLD."runApprovalAuditLogId") THEN
        RAISE EXCEPTION 'one-shot supersession audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "prompt_refiner_vnext_one_shot_v3_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    previous_stage RECORD;
    first_stage RECORD;
    linked_audit RECORD;
    previous_slots BIGINT;
    previous_consumed BIGINT;
    previous_wrong_ids BIGINT;
    first_slots BIGINT;
    first_consumed BIGINT;
    forbidden_audits BIGINT;
BEGIN
    IF NEW."id" <> 'prompt-refiner-vnext-one-shot-v3' THEN RETURN NEW; END IF;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v1'' FOR NO KEY UPDATE',
        TG_TABLE_SCHEMA
    ) INTO first_stage;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v2'' FOR NO KEY UPDATE',
        TG_TABLE_SCHEMA
    ) INTO previous_stage;
    IF first_stage."status" IS DISTINCT FROM 'closed' OR
       first_stage."runApprovalAuditLogId" IS NOT NULL OR
       first_stage."supersededAuditLogId" IS NULL OR
       previous_stage."status" IS DISTINCT FROM 'closed' OR
       previous_stage."runApprovalAuditLogId" IS NULL OR
       previous_stage."supersededAuditLogId" IS NULL OR
       previous_stage."runtimeDeploymentId" IS DISTINCT FROM
         '3565f671-c168-4d3d-8573-8e79126e1c63' OR
       previous_stage."runtimeCommitSha" IS DISTINCT FROM
         '291e6d07f284e6333c34a3061dd94da77752aad9' OR
       previous_stage."stageApprovalAuditLogId" IS DISTINCT FROM
         'cmuuyx04a001d02qt3ald6khq' OR
       previous_stage."runApprovalAuditLogId" IS DISTINCT FROM
         'cmuuz1ltu002002qtnct9lojp' THEN
        RAISE EXCEPTION 'one-shot v3 recovery requires the exact closed source';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "actorUserId", "action", "targetType", "targetId", "metadata", "entryHash"'
        || ' FROM %I."AdminAuditLog" WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
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
       NEW."approvedBy" IS DISTINCT FROM previous_stage."approvedBy" OR
       NEW."sourceCommitSha" IS DISTINCT FROM previous_stage."sourceCommitSha" OR
       NEW."sourceManifestDigest" IS DISTINCT FROM previous_stage."sourceManifestDigest" OR
       NEW."runnerDigest" IS DISTINCT FROM previous_stage."runnerDigest" OR
       NEW."manifestRoot" IS DISTINCT FROM previous_stage."manifestRoot" OR
       NEW."pricePinDigest" IS DISTINCT FROM previous_stage."pricePinDigest" OR
       NEW."perRequestCostMicroUsd" IS DISTINCT FROM previous_stage."perRequestCostMicroUsd" OR
       NEW."slotCount" IS DISTINCT FROM previous_stage."slotCount" OR
       NEW."costCeilingMicroUsd" IS DISTINCT FROM previous_stage."costCeilingMicroUsd" OR
       NEW."runtimeDeploymentId" IS NOT DISTINCT FROM previous_stage."runtimeDeploymentId" OR
       NEW."runtimeCommitSha" IS NOT DISTINCT FROM previous_stage."runtimeCommitSha" THEN
        RAISE EXCEPTION 'one-shot v3 recovery binding is invalid';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed'')'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v1''', TG_TABLE_SCHEMA
    ) INTO first_slots, first_consumed;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed''),'
        || ' count(*) FILTER (WHERE "id" <> ''one-shot-v2-'' || "slotIndex"::text)'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v2''', TG_TABLE_SCHEMA
    ) INTO previous_slots, previous_consumed, previous_wrong_ids;
    IF first_slots <> 80 OR first_consumed <> 0 OR
       previous_slots <> 80 OR previous_consumed <> 0 OR previous_wrong_ids <> 0 THEN
        RAISE EXCEPTION 'one-shot v3 recovery requires untouched historical slots';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."AdminAuditLog" WHERE '
        || '("targetType" = ''PromptRefinerVnextOneShotStage'' AND'
        || ' "targetId" = ''prompt-refiner-vnext-one-shot-v2'' AND'
        || ' "action" IN (''prompt_refiner.vnext_one_shot.operational_shadow_completed'','
        || ' ''prompt_refiner.vnext_one_shot.outcome_unknown'','
        || ' ''prompt_refiner.vnext_one_shot.gate_evaluated'','
        || ' ''prompt_refiner.vnext_one_shot.disposition_recorded'','
        || ' ''prompt_refiner.vnext_one_shot.paid_dispatch_authorized'')) OR'
        || ' ("targetType" = ''PromptRefinerVnextOneShotSlot'' AND'
        || ' "targetId" LIKE ''one-shot-v2-%%'' AND'
        || ' "action" = ''prompt_refiner.vnext_one_shot.slot_consumed'')',
        TG_TABLE_SCHEMA
    ) INTO forbidden_audits;
    IF forbidden_audits <> 0 THEN
        RAISE EXCEPTION 'one-shot v3 recovery has forbidden historical evidence';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_v3_guard_trigger"
BEFORE INSERT ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v3_guard"();

-- A v2 close is never durable without the one v3 stage in the same transaction.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_v3_complete"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE replacement_count BIGINT;
BEGIN
    IF OLD."id" <> 'prompt-refiner-vnext-one-shot-v2' OR
       OLD."status" <> 'run_approved' OR NEW."status" <> 'closed' OR
       NEW."supersededAuditLogId" IS NULL THEN RETURN NEW; END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v3'' AND "status" = ''staged''',
        TG_TABLE_SCHEMA
    ) INTO replacement_count;
    IF replacement_count <> 1 THEN
        RAISE EXCEPTION 'one-shot v2 close requires v3 in the same transaction';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "prompt_refiner_vnext_one_shot_v3_complete_trigger"
AFTER UPDATE ON "PromptRefinerVnextOneShotStage"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v3_complete"();
