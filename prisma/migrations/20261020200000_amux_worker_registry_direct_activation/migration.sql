-- baseline-check: replace-function-if-body-sha256 "amux_worker_registry_event_guard" "088bfed59b1abfd0ea2db1f71d5b2f61b7690c2159a5bea65f3e3ae1ab0c14de"
-- Orchestration policy version 31 (docs/policy/development-agent-orchestration.md,
-- "버전 31"), sections 3 and 5, as the operator decided on 2026-10-20: the
-- owner may make a worker 'active' in Admin directly, with no R5 trial period.
-- Replaces one function body, the registry event guard of
-- 20261012100000_amux_worker_registry. No table, column, constraint, trigger
-- or row changes.
--
-- Two rules of the guard change, and nothing else:
--   * a first event is 'requested' or 'active', for any worker name. The list
--     of the assignment catalog's seven goes: it existed only because no other
--     worker could be activated;
--   * a later event may make a worker 'active' from 'requested' or 'paused':
--     the AMUX_WORKER_REGISTRY_ACTIVATION refusal goes.
-- Every other line is the previous body unchanged: nothing follows 'retired';
-- the class never changes; the revision is the previous plus one, read under
-- the per-worker advisory lock; a wider role only while the new event is
-- 'requested'; the person's audit row of this very transaction under
-- amux.worker.register or amux.worker.change, with no system marker; the
-- database clock; no update or delete; READ COMMITTED only. The table's CHECKs
-- are untouched, so Cursor and Copilot still never hold contract.
-- lib/amux/workerRegistryCore.ts holds the same rule, and
-- tests/amuxWorkerRegistryStore.test.mjs fails if this body is anything but
-- the previous one with those two edits.
--
-- What this makes irreversible: an 'active' event recorded without trial
-- evidence. Registry events are append-only, so it stays in the history; a
-- later 'paused' or 'retired' event stops the worker. An active worker with
-- recorded capabilities enters the derived assignment catalog (version 35).
--
-- The header pins the previous body for the baseline guard
-- (scripts/baseline-presence-core.mjs); the DO block pins it again inside the
-- transaction, so a hand edit or an unknown version stops the migration
-- before anything changes.
--
-- Rollback: re-run the CREATE OR REPLACE FUNCTION of
-- 20261012100000_amux_worker_registry. That restores the old rule for new
-- events only; an 'active' event already recorded stays.

BEGIN;

DO $pin$
DECLARE
    actual TEXT;
BEGIN
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
      INTO actual
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = pg_catalog.current_schema()
       AND p.proname = 'amux_worker_registry_event_guard'
       AND p.pronargs = 0
       AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;
    IF actual IS DISTINCT FROM '088bfed59b1abfd0ea2db1f71d5b2f61b7690c2159a5bea65f3e3ae1ab0c14de' THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_UNEXPECTED_FUNCTION_BODY';
    END IF;
END
$pin$;

CREATE OR REPLACE FUNCTION "amux_worker_registry_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    previous_sequence BIGINT;
    previous_class TEXT;
    previous_role TEXT;
    previous_state TEXT;
    previous_revision INTEGER;
    expected_action TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_IMMUTABLE';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_ISOLATION';
    END IF;

    -- One insert per worker at a time, so the newest event read below is
    -- still the newest when this one commits.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-registry:' || NEW."workerName")
    );
    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT "sequence", "providerClass", "roleCeiling", "desiredState", "revision" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerRegistryEvent'
    ) INTO previous_sequence, previous_class, previous_role, previous_state, previous_revision
      USING NEW."workerName";

    IF previous_sequence IS NULL THEN
        IF NEW."revision" <> 1 THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_STALE_REVISION';
        END IF;
        IF NEW."desiredState" NOT IN ('requested', 'active') THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_FIRST_STATE';
        END IF;
        expected_action := 'amux.worker.register';
    ELSE
        IF NEW."sequence" <= previous_sequence THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_OUT_OF_ORDER';
        END IF;
        IF NEW."revision" <> previous_revision + 1 THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_STALE_REVISION';
        END IF;
        IF NEW."providerClass" <> previous_class THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_CLASS_CHANGED';
        END IF;
        IF previous_state = 'retired' THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_RETIRED';
        END IF;
        IF pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], NEW."roleCeiling")
             > pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], previous_role)
           AND NEW."desiredState" <> 'requested' THEN
            RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_ROLE_WIDENING';
        END IF;
        expected_action := 'amux.worker.change';
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", expected_action, 'AmuxWorkerRegistryEvent', NEW."id", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_WORKER_REGISTRY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
