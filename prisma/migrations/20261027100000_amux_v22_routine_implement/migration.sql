-- Orchestration policy version 52 made a v4 Task worker's registry
-- roleCeiling its grade, not a cap: a routine Task runs only on a chore
-- worker. The capability guard still held v22 implement to an implementation
-- ceiling (version 35), so no chore worker could carry implement, no routine
-- implement route was priced and every idea with a routine implement Task
-- failed unattended registration (production, 2026-10-27). Owner decision
-- 2026-10-27: v22 implement needs repo_write and no ceiling; a Cursor worker
-- still takes no implement role, and the legacy implementation tag keeps its
-- ceiling. This replaces the guard body only -- the latest definition
-- (20261026100000) with that one condition removed. No table, constraint or
-- row changes; recorded capabilities were all valid under the stricter rule.
-- baseline-check: replace-function-if-body-sha256 "amux_worker_capability_event_guard" "d031d0c448720ca8d9261efdd396f971c7c1c3b6101082df4499289cf6637ad3"
BEGIN;

CREATE OR REPLACE FUNCTION "amux_worker_capability_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    registry_class TEXT;
    registry_ceiling TEXT;
    registry_state TEXT;
    previous_sequence BIGINT;
    previous_revision INTEGER;
    ceiling_rank INTEGER;
    verified BOOLEAN;
    tag TEXT;
    role TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_IMMUTABLE';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_ISOLATION';
    END IF;

    -- The registry's lock first (its guard takes the same key), then this
    -- table's: a ceiling change and a capability write never interleave.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-registry:' || NEW."workerName")
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-capability:' || NEW."workerName")
    );

    EXECUTE pg_catalog.format(
        'SELECT "providerClass", "roleCeiling", "desiredState" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerRegistryEvent'
    ) INTO registry_class, registry_ceiling, registry_state USING NEW."workerName";
    IF registry_class IS NULL THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_NOT_REGISTERED';
    END IF;
    IF registry_state = 'retired' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_RETIRED';
    END IF;
    ceiling_rank := pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], registry_ceiling);
    verified := registry_class IN ('claude', 'codex');

    IF pg_catalog.cardinality(NEW."routingTags") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."routingTags") AS t)
       OR pg_catalog.cardinality(NEW."toolCapabilities") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."toolCapabilities") AS t)
       OR (NEW."v22Roles" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Roles") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Roles") AS t))
       OR (NEW."v22Tools" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Tools") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Tools") AS t)) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_DUPLICATE';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW."toolCapabilities") AS t WHERE pg_catalog.length(t) NOT BETWEEN 1 AND 64) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TOOLS';
    END IF;

    FOREACH tag IN ARRAY NEW."routingTags" LOOP
        IF tag = 'implementation' AND ceiling_rank < 2 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag IN ('contract', 'architecture', 'security') AND ceiling_rank < 3 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag = 'review' AND NOT verified THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_VERIFIED';
        END IF;
    END LOOP;

    IF NEW."v22Roles" IS NOT NULL THEN
        -- Every provider class may run v22; a Claude worker stays on a
        -- claude-* model (owner decision 2026-10-26).
        IF registry_class = 'claude' AND NEW."v22Model" !~ '^claude-[A-Za-z0-9._-]{1,120}$' THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_CLASS';
        END IF;
        -- Cursor's print mode reaches its shell once it may write: read roles only.
        IF registry_class = 'cursor' AND 'implement' = ANY (NEW."v22Roles") THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
        END IF;
        FOREACH role IN ARRAY NEW."v22Roles" LOOP
            -- Version 52: a v4 worker's ceiling is its grade, not a cap, so a
            -- chore worker runs routine implement Tasks (owner decision
            -- 2026-10-27). It still needs repo_write.
            IF role = 'implement' AND NOT ('repo_write' = ANY (NEW."v22Tools")) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'design' AND (ceiling_rank < 3 OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'investigate' AND NOT ('repo_read' = ANY (NEW."v22Tools")) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'review' AND (NOT verified OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
        END LOOP;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT "sequence", "revision" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerCapabilityEvent'
    ) INTO previous_sequence, previous_revision USING NEW."workerName";
    IF NEW."revision" <> COALESCE(previous_revision, 0) + 1 THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_STALE_REVISION';
    END IF;
    IF previous_sequence IS NOT NULL AND NEW."sequence" <= previous_sequence THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_OUT_OF_ORDER';
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.worker.capability', 'AmuxWorkerCapabilityEvent', NEW."id", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
