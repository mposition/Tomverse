-- baseline-check: present-if-function "prompt_refiner_vnext_one_shot_v5_guard"
-- A new independent v5 stage may follow only the signed v4 safe stop.
-- No historical row is rewritten, deleted, retried or relabelled.
ALTER TABLE "PromptRefinerVnextOneShotStage"
    DROP CONSTRAINT "PromptRefinerVnextOneShotStage_id_check";
ALTER TABLE "PromptRefinerVnextOneShotStage"
    ADD CONSTRAINT "PromptRefinerVnextOneShotStage_id_check"
    CHECK ("id" IN (
        'prompt-refiner-vnext-one-shot-v1',
        'prompt-refiner-vnext-one-shot-v2',
        'prompt-refiner-vnext-one-shot-v3',
        'prompt-refiner-vnext-one-shot-v4',
        'prompt-refiner-vnext-one-shot-v5'
    ));

CREATE FUNCTION "prompt_refiner_vnext_one_shot_v5_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    predecessor RECORD;
    recovery RECORD;
    stop_receipt RECORD;
    slot_count BIGINT;
    consumed_count BIGINT;
    wrong_shape BIGINT;
    terminal_count BIGINT;
    recovery_count BIGINT;
    observed_at TIMESTAMP(3);
BEGIN
    IF NEW."id" <> 'prompt-refiner-vnext-one-shot-v5' THEN RETURN NEW; END IF;
    EXECUTE pg_catalog.format(
        'SELECT * FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = ''prompt-refiner-vnext-one-shot-v4'''
        || ' FOR NO KEY UPDATE', TG_TABLE_SCHEMA
    ) INTO predecessor;
    IF predecessor."id" IS DISTINCT FROM 'prompt-refiner-vnext-one-shot-v4' OR
       predecessor."status" IS DISTINCT FROM 'closed' OR
       predecessor."runtimeDeploymentId" IS DISTINCT FROM
         '35787baf-2329-4002-b837-182ae9f51d13' OR
       predecessor."runtimeCommitSha" IS DISTINCT FROM
         'e3ecfcdc5eee9cbce8f79fda39eb76a87c445819' OR
       predecessor."runApprovalAuditLogId" IS NULL OR
       NEW."approvedBy" IS DISTINCT FROM predecessor."approvedBy" OR
       NEW."sourceCommitSha" IS DISTINCT FROM predecessor."sourceCommitSha" OR
       NEW."sourceManifestDigest" IS DISTINCT FROM predecessor."sourceManifestDigest" OR
       NEW."pricePinDigest" IS DISTINCT FROM predecessor."pricePinDigest" OR
       NEW."perRequestCostMicroUsd" IS DISTINCT FROM predecessor."perRequestCostMicroUsd" OR
       NEW."costCeilingMicroUsd" IS DISTINCT FROM predecessor."costCeilingMicroUsd" OR
       NEW."slotCount" IS DISTINCT FROM predecessor."slotCount" OR
       NEW."runnerDigest" IS NOT DISTINCT FROM predecessor."runnerDigest" OR
       NEW."manifestRoot" IS NOT DISTINCT FROM predecessor."manifestRoot" OR
       NEW."runtimeDeploymentId" IS NOT DISTINCT FROM predecessor."runtimeDeploymentId" OR
       NEW."runtimeCommitSha" IS NOT DISTINCT FROM predecessor."runtimeCommitSha" THEN
        RAISE EXCEPTION 'one-shot v5 requires exact immutable v4 safe stop';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*), count(*) FILTER (WHERE "status" = ''consumed''),'
        || ' count(*) FILTER (WHERE "id" <> ''one-shot-v4-'' || "slotIndex"::text'
        || ' OR ("slotIndex" <= 33 AND "status" <> ''consumed'')'
        || ' OR ("slotIndex" > 33 AND "status" <> ''reserved''))'
        || ' FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = ''prompt-refiner-vnext-one-shot-v4''', TG_TABLE_SCHEMA
    ) INTO slot_count, consumed_count, wrong_shape;
    IF slot_count <> 80 OR consumed_count <> 34 OR wrong_shape <> 0 THEN
        RAISE EXCEPTION 'one-shot v5 requires exact v4 slot shape';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."AdminAuditLog"'
        || ' WHERE "action" = ''prompt_refiner.vnext_one_shot.terminal_recorded'''
        || ' AND "targetType" = ''PromptRefinerVnextOneShotSlot'''
        || ' AND "targetId" LIKE ''one-shot-v4-%%''', TG_TABLE_SCHEMA
    ) INTO terminal_count;
    IF terminal_count <> 33 THEN
        RAISE EXCEPTION 'one-shot v5 requires 33 v4 terminal receipts';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."AdminAuditLog"'
        || ' WHERE "action" = ''prompt_refiner.vnext_one_shot.post_unknown_new_run_approved'''
        || ' AND "targetType" = ''PromptRefinerVnextOneShotStage'''
        || ' AND "targetId" = ''prompt-refiner-vnext-one-shot-v4''', TG_TABLE_SCHEMA
    ) INTO recovery_count;
    IF recovery_count <> 1 THEN
        RAISE EXCEPTION 'one-shot v5 requires one linked recovery audit';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "actorUserId", "action", "targetType", "targetId",'
        || ' "summary", "metadata", "entryHash", "createdAt"'
        || ' FROM %I."AdminAuditLog"'
        || ' WHERE "action" = ''prompt_refiner.vnext_one_shot.post_unknown_new_run_approved'''
        || ' AND "targetId" = ''prompt-refiner-vnext-one-shot-v4'''
        || ' FOR KEY SHARE', TG_TABLE_SCHEMA
    ) INTO recovery;
    EXECUTE pg_catalog.format(
        'SELECT "action", "targetType", "targetId", "metadata", "entryHash"'
        || ' FROM %I."AdminAuditLog" WHERE "id" = $1 FOR KEY SHARE',
        TG_TABLE_SCHEMA
    ) INTO stop_receipt USING recovery."metadata" ->> 'predecessorStopAuditLogId';
    observed_at := clock_timestamp() AT TIME ZONE 'UTC';
    IF recovery."actorUserId" IS DISTINCT FROM NEW."approvedBy" OR
       recovery."targetType" IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
       recovery."summary" IS DISTINCT FROM
         'Approved one independent v5 stage after the immutable v4 safe stop.' OR
       recovery."entryHash" IS NULL OR recovery."entryHash" !~ '^[a-f0-9]{64}$' OR
       recovery."createdAt" < observed_at - INTERVAL '1 minute' OR
       recovery."createdAt" > observed_at + INTERVAL '1 minute' OR
       stop_receipt."action" IS DISTINCT FROM
         'prompt_refiner.vnext_one_shot.outcome_unknown' OR
       stop_receipt."targetType" IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
       stop_receipt."targetId" IS DISTINCT FROM predecessor."id" OR
       stop_receipt."entryHash" IS NULL OR
       stop_receipt."entryHash" !~ '^[a-f0-9]{64}$' OR
       stop_receipt."metadata" ->> 'slotIndex' IS DISTINCT FROM '33' OR
       stop_receipt."metadata" ->> 'runApprovalAuditLogId' IS DISTINCT FROM
         predecessor."runApprovalAuditLogId" OR
       recovery."metadata" IS DISTINCT FROM jsonb_build_object(
         'version', 'prompt-refiner-vnext-one-shot-post-unknown-v1',
         'predecessorStageId', predecessor."id",
         'successorStageId', NEW."id",
         'predecessorStopAuditLogId', recovery."metadata" ->> 'predecessorStopAuditLogId',
         'predecessorStageApprovalAuditLogId', predecessor."stageApprovalAuditLogId",
         'predecessorRunApprovalAuditLogId', predecessor."runApprovalAuditLogId",
         'successorStageApprovalAuditLogId', NEW."stageApprovalAuditLogId",
         'predecessorTerminalReceipts', 33,
         'predecessorUnknownReceipts', 1,
         'predecessorNotAttemptedSlots', 46,
         'predecessorObservedCostMicroUsd', 7624,
         'predecessorHeldCostUpperBoundMicroUsd', 29918,
         'successorRunCeilingMicroUsd', 2393440,
         'crossRunWorstCaseMicroUsd', 2430982
       ) THEN
        RAISE EXCEPTION 'one-shot v5 recovery audit binding is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_v5_guard_trigger"
BEFORE INSERT ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v5_guard"();

CREATE FUNCTION "prompt_refiner_vnext_one_shot_v5_slot_shape"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NEW."stageId" = 'prompt-refiner-vnext-one-shot-v5' AND
       (NEW."id" IS DISTINCT FROM 'one-shot-v5-' || NEW."slotIndex"::text OR
        NEW."status" IS DISTINCT FROM 'reserved') THEN
        RAISE EXCEPTION 'one-shot v5 slot shape is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_v5_slot_shape_trigger"
BEFORE INSERT ON "PromptRefinerVnextOneShotSlot"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_v5_slot_shape"();
