-- Dark, content-free reservation storage for the separately approved vNext
-- one-shot contract. No stage is seeded and no provider path reads these rows.
-- The v1 shadow tables remain untouched (100 slots at a different price).
CREATE TABLE "PromptRefinerVnextOneShotStage" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "sourceCommitSha" TEXT NOT NULL,
    "sourceManifestDigest" TEXT NOT NULL,
    "runnerDigest" TEXT NOT NULL,
    "manifestRoot" TEXT NOT NULL,
    "runtimeDeploymentId" TEXT NOT NULL,
    "runtimeCommitSha" TEXT NOT NULL,
    "pricePinDigest" TEXT NOT NULL,
    "perRequestCostMicroUsd" BIGINT NOT NULL,
    "slotCount" INTEGER NOT NULL,
    "costCeilingMicroUsd" BIGINT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "stageApprovalAuditLogId" TEXT NOT NULL,
    "runApprovalAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PromptRefinerVnextOneShotStage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerVnextOneShotStage_status_check"
        CHECK ("status" IN ('staged', 'run_approved', 'closed')),
    CONSTRAINT "PromptRefinerVnextOneShotStage_run_approval_check"
        CHECK (("status" <> 'run_approved' OR "runApprovalAuditLogId" IS NOT NULL) AND
               ("status" <> 'staged' OR "runApprovalAuditLogId" IS NULL)),
    CONSTRAINT "PromptRefinerVnextOneShotStage_id_check"
        CHECK ("id" = 'prompt-refiner-vnext-one-shot-v1'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_source_commit_check"
        CHECK ("sourceCommitSha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_runtime_commit_check"
        CHECK ("runtimeCommitSha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_manifest_digest_check"
        CHECK ("sourceManifestDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_runner_digest_check"
        CHECK ("runnerDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_root_check"
        CHECK ("manifestRoot" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_price_digest_check"
        CHECK ("pricePinDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_deployment_check"
        CHECK ("runtimeDeploymentId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "PromptRefinerVnextOneShotStage_cost_check"
        CHECK ("slotCount" = 80 AND "perRequestCostMicroUsd" = 29918 AND
               "costCeilingMicroUsd" = 2393440),
    CONSTRAINT "PromptRefinerVnextOneShotStage_actor_check"
        CHECK (length("approvedBy") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX "PromptRefinerVnextOneShotStage_stageApprovalAuditLogId_key"
    ON "PromptRefinerVnextOneShotStage"("stageApprovalAuditLogId");
CREATE UNIQUE INDEX "PromptRefinerVnextOneShotStage_runApprovalAuditLogId_key"
    ON "PromptRefinerVnextOneShotStage"("runApprovalAuditLogId");
-- Verify audit references under a key-share lock in the stage trigger below.
-- A permanent FK would prevent existing isolated DB tests from truncating the
-- append-only audit table even when this dark table has no rows.

CREATE TABLE "PromptRefinerVnextOneShotSlot" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reservedCostMicroUsd" BIGINT NOT NULL,
    "requestId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptRefinerVnextOneShotSlot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_id_check"
        CHECK (length("id") BETWEEN 1 AND 128 AND "id" ~ '^[A-Za-z0-9:_-]+$'),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_index_check"
        CHECK ("slotIndex" BETWEEN 0 AND 79),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_cost_check"
        CHECK ("reservedCostMicroUsd" = 29918),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_status_check"
        CHECK ("status" IN ('reserved', 'consumed')),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_state_check"
        CHECK (("status" = 'reserved' AND "requestId" IS NULL AND "consumedAt" IS NULL) OR
               ("status" = 'consumed' AND "requestId" IS NOT NULL AND "consumedAt" IS NOT NULL)),
    CONSTRAINT "PromptRefinerVnextOneShotSlot_request_check"
        CHECK ("requestId" IS NULL OR
               (length("requestId") BETWEEN 1 AND 128 AND "requestId" ~ '^[A-Za-z0-9:_-]+$'))
);

CREATE UNIQUE INDEX "PromptRefinerVnextOneShotSlot_stageId_slotIndex_key"
    ON "PromptRefinerVnextOneShotSlot"("stageId", "slotIndex");
CREATE UNIQUE INDEX "PromptRefinerVnextOneShotSlot_requestId_key"
    ON "PromptRefinerVnextOneShotSlot"("requestId");
CREATE INDEX "PromptRefinerVnextOneShotSlot_stageId_status_idx"
    ON "PromptRefinerVnextOneShotSlot"("stageId", "status");
ALTER TABLE "PromptRefinerVnextOneShotSlot"
    ADD CONSTRAINT "PromptRefinerVnextOneShotSlot_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "PromptRefinerVnextOneShotStage"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Stage creation must atomically allocate all 80 distinct reserved slots.
-- The deferred check permits the app to insert the stage and slots in one
-- transaction, but never to commit a partial reservation.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_stage_complete"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    reserved_count BIGINT;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT count(*) FROM %I."PromptRefinerVnextOneShotSlot"'
        || ' WHERE "stageId" = $1 AND "status" = ''reserved''', TG_TABLE_SCHEMA
    ) INTO reserved_count USING NEW."id";
    IF reserved_count <> 80 THEN
        RAISE EXCEPTION 'one-shot stage requires exactly 80 reserved slots';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "prompt_refiner_vnext_one_shot_stage_complete_trigger"
AFTER INSERT ON "PromptRefinerVnextOneShotStage"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_stage_complete"();

CREATE FUNCTION "prompt_refiner_vnext_one_shot_stage_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    audit_actor TEXT;
    audit_action TEXT;
    audit_summary TEXT;
    audit_target_type TEXT;
    audit_target_id TEXT;
    audit_metadata JSONB;
    audit_entry_hash TEXT;
    audit_created_at TIMESTAMP(3);
    audit_row_count BIGINT;
    observed_at TIMESTAMP(3);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'staged' OR NEW."runApprovalAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'one-shot stage must start staged';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT "actorUserId", "action", "summary", "targetType", "targetId",'
            || ' "metadata", "entryHash", "createdAt" FROM %I."AdminAuditLog"'
            || ' WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
        ) INTO audit_actor, audit_action, audit_summary, audit_target_type, audit_target_id,
               audit_metadata, audit_entry_hash, audit_created_at
          USING NEW."stageApprovalAuditLogId";
        GET DIAGNOSTICS audit_row_count = ROW_COUNT;
        IF audit_row_count <> 1 THEN
            RAISE EXCEPTION 'one-shot stage approval audit is missing';
        END IF;
        observed_at := clock_timestamp() AT TIME ZONE 'UTC';
        IF audit_created_at < observed_at - INTERVAL '1 minute' OR
           audit_created_at > observed_at + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'one-shot stage approval audit is stale';
        END IF;
        IF audit_actor IS DISTINCT FROM NEW."approvedBy" OR
           audit_action IS DISTINCT FROM 'prompt_refiner.vnext_one_shot.stage_approved' OR
           audit_summary IS DISTINCT FROM 'Approved the bounded Prompt Refiner vNext one-shot stage.' OR
           audit_target_type IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
           audit_target_id IS DISTINCT FROM NEW."id" OR
           audit_entry_hash IS NULL OR audit_entry_hash !~ '^[a-f0-9]{64}$' OR
           audit_metadata IS DISTINCT FROM jsonb_build_object(
               'approvalKind', 'stage',
               'sourceCommitSha', NEW."sourceCommitSha",
               'sourceManifestDigest', NEW."sourceManifestDigest",
               'runnerDigest', NEW."runnerDigest",
               'manifestRoot', NEW."manifestRoot",
               'runtimeDeploymentId', NEW."runtimeDeploymentId",
               'runtimeCommitSha', NEW."runtimeCommitSha",
               'pricePinDigest', NEW."pricePinDigest",
               'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
               'slotCount', NEW."slotCount",
               'costCeilingMicroUsd', NEW."costCeilingMicroUsd"
           ) THEN
            RAISE EXCEPTION 'one-shot stage approval audit binding is invalid';
        END IF;
        NEW."approvedAt" := audit_created_at;
        NEW."createdAt" := observed_at;
        NEW."updatedAt" := observed_at;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'one-shot stage cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."sourceCommitSha" IS DISTINCT FROM OLD."sourceCommitSha" OR
       NEW."sourceManifestDigest" IS DISTINCT FROM OLD."sourceManifestDigest" OR
       NEW."runnerDigest" IS DISTINCT FROM OLD."runnerDigest" OR
       NEW."manifestRoot" IS DISTINCT FROM OLD."manifestRoot" OR
       NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId" OR
       NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha" OR
       NEW."pricePinDigest" IS DISTINCT FROM OLD."pricePinDigest" OR
       NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd" OR
       NEW."slotCount" IS DISTINCT FROM OLD."slotCount" OR
       NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd" OR
       NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy" OR
       NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR
       NEW."stageApprovalAuditLogId" IS DISTINCT FROM OLD."stageApprovalAuditLogId" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
       NOT (
           (OLD."status" = 'staged' AND NEW."status" = 'run_approved' AND
            OLD."runApprovalAuditLogId" IS NULL AND NEW."runApprovalAuditLogId" IS NOT NULL) OR
           (OLD."status" IN ('staged', 'run_approved') AND NEW."status" = 'closed' AND
            NEW."runApprovalAuditLogId" IS NOT DISTINCT FROM OLD."runApprovalAuditLogId")
       ) THEN
        RAISE EXCEPTION 'one-shot stage transition is not permitted';
    END IF;
    IF OLD."status" = 'staged' AND NEW."status" = 'run_approved' THEN
        IF NEW."runApprovalAuditLogId" = NEW."stageApprovalAuditLogId" THEN
            RAISE EXCEPTION 'one-shot run approval requires a distinct audit';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT "actorUserId", "action", "summary", "targetType", "targetId",'
            || ' "metadata", "entryHash", "createdAt" FROM %I."AdminAuditLog"'
            || ' WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA
        ) INTO audit_actor, audit_action, audit_summary, audit_target_type, audit_target_id,
               audit_metadata, audit_entry_hash, audit_created_at
          USING NEW."runApprovalAuditLogId";
        GET DIAGNOSTICS audit_row_count = ROW_COUNT;
        IF audit_row_count <> 1 THEN
            RAISE EXCEPTION 'one-shot run approval audit is missing';
        END IF;
        observed_at := clock_timestamp() AT TIME ZONE 'UTC';
        IF audit_created_at < observed_at - INTERVAL '1 minute' OR
           audit_created_at > observed_at + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'one-shot run approval audit is stale';
        END IF;
        IF audit_created_at <= OLD."approvedAt" THEN
            RAISE EXCEPTION 'one-shot run approval must follow stage approval';
        END IF;
        IF audit_actor IS DISTINCT FROM NEW."approvedBy" OR
           audit_action IS DISTINCT FROM 'prompt_refiner.vnext_one_shot.run_approved' OR
           audit_summary IS DISTINCT FROM 'Approved the bounded Prompt Refiner vNext one-shot run.' OR
           audit_target_type IS DISTINCT FROM 'PromptRefinerVnextOneShotStage' OR
           audit_target_id IS DISTINCT FROM NEW."id" OR
           audit_entry_hash IS NULL OR audit_entry_hash !~ '^[a-f0-9]{64}$' OR
           audit_metadata IS DISTINCT FROM jsonb_build_object(
               'approvalKind', 'run',
               'sourceCommitSha', NEW."sourceCommitSha",
               'sourceManifestDigest', NEW."sourceManifestDigest",
               'runnerDigest', NEW."runnerDigest",
               'manifestRoot', NEW."manifestRoot",
               'runtimeDeploymentId', NEW."runtimeDeploymentId",
               'runtimeCommitSha', NEW."runtimeCommitSha",
               'pricePinDigest', NEW."pricePinDigest",
               'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
               'slotCount', NEW."slotCount",
               'costCeilingMicroUsd', NEW."costCeilingMicroUsd"
           ) THEN
            RAISE EXCEPTION 'one-shot run approval audit binding is invalid';
        END IF;
    END IF;
    NEW."updatedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_stage_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerVnextOneShotStage"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_stage_guard"();

-- A consumed slot is a permanent tombstone. Neither a failed response nor an
-- unknown provider outcome can make its index or request identity reusable.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_slot_guard"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    stage_status TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'one-shot slots cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'reserved' OR NEW."requestId" IS NOT NULL OR
           NEW."consumedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'one-shot slot must start reserved';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT "status" FROM %I."PromptRefinerVnextOneShotStage"'
            || ' WHERE "id" = $1 FOR SHARE', TG_TABLE_SCHEMA
        ) INTO stage_status USING NEW."stageId";
        IF stage_status IS DISTINCT FROM 'staged' THEN
            RAISE EXCEPTION 'one-shot stage must be staged for slot allocation';
        END IF;
        NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."stageId" IS DISTINCT FROM OLD."stageId" OR
       NEW."slotIndex" IS DISTINCT FROM OLD."slotIndex" OR
       NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
       OLD."status" <> 'reserved' OR NEW."status" <> 'consumed' OR
       NEW."requestId" IS NULL THEN
        RAISE EXCEPTION 'one-shot slot transition is not permitted';
    END IF;
    IF NEW."consumedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'one-shot consumption timestamp is database-owned';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT "status" FROM %I."PromptRefinerVnextOneShotStage"'
        || ' WHERE "id" = $1 FOR SHARE', TG_TABLE_SCHEMA
    ) INTO stage_status USING OLD."stageId";
    IF stage_status IS DISTINCT FROM 'run_approved' THEN
        RAISE EXCEPTION 'one-shot run approval is required before consumption';
    END IF;
    NEW."consumedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_slot_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerVnextOneShotSlot"
FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_slot_guard"();

-- Row guards do not fire for a statement-level truncate. Keep the singleton
-- stage and consumed-slot tombstones intact even for a direct SQL caller.
CREATE FUNCTION "prompt_refiner_vnext_one_shot_no_truncate"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'one-shot stage and slots cannot be truncated';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prompt_refiner_vnext_one_shot_stage_no_truncate_trigger"
BEFORE TRUNCATE ON "PromptRefinerVnextOneShotStage"
FOR EACH STATEMENT EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_no_truncate"();
CREATE TRIGGER "prompt_refiner_vnext_one_shot_slot_no_truncate_trigger"
BEFORE TRUNCATE ON "PromptRefinerVnextOneShotSlot"
FOR EACH STATEMENT EXECUTE FUNCTION "prompt_refiner_vnext_one_shot_no_truncate"();
