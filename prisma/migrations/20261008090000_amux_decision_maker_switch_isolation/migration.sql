-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_switch_event_guard" "d26f196a8474c90d48a4dd4cd45ac6d3fe1c05d558aea14a98fc52d678510be5"
-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- section 8: the switch store of stage S1b, one correction from its review.
-- Replaces one function body; no table, column, constraint, trigger or row
-- changes.
--
-- The switch event guard (20261008030000_amux_decision_maker_switch) takes a
-- per-scope advisory lock and then reads the scope's newest event in a
-- separate statement, so that a transaction the lock waited for is seen once
-- it has committed. That holds only under READ COMMITTED, where each statement
-- takes a new snapshot. Under REPEATABLE READ or SERIALIZABLE the snapshot is
-- the transaction's first, taken before the lock wait, so the read can miss a
-- latch committed meanwhile: a person's change would then pass as
-- amux.decision.mode where the first change after a latch must be
-- amux.decision.latch_release, and the sequence comparison would look at a
-- stale newest event. The guard now refuses an insert under any other
-- isolation level (AMUX_DM_SWITCH_ISOLATION). The application writes it only
-- under READ COMMITTED -- the AMUX mutation boundary's level and PostgreSQL's
-- default -- so nothing it does today changes.
--
-- The refusal of UPDATE and DELETE comes first, as before, whatever the level.
-- Every other line of the function is the S1b body unchanged.
--
-- Rollback: re-run the CREATE OR REPLACE FUNCTION of migration
-- 20261008030000_amux_decision_maker_switch, which restores the body without
-- the isolation check.

BEGIN;

CREATE OR REPLACE FUNCTION "amux_decision_maker_switch_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    newest_sequence BIGINT;
    newest_actor_kind TEXT;
    expected_action TEXT;
    expected_actor TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_IMMUTABLE';
    END IF;
    -- The newest event below is read after a lock. Only READ COMMITTED gives
    -- that read a snapshot taken after the lock was granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_ISOLATION';
    END IF;

    -- One insert per scope at a time, so the newest event read below is still
    -- the newest when this one commits. The writer already holds the audit
    -- chain lock, which every audit append takes first; this lock is the
    -- database's own and does not rely on that.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-switch:' || NEW."scope")
    );
    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT "sequence", "actorKind" FROM %I.%I WHERE "scope" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerSwitchEvent'
    ) INTO newest_sequence, newest_actor_kind USING NEW."scope";
    IF newest_sequence IS NOT NULL AND NEW."sequence" <= newest_sequence THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_OUT_OF_ORDER';
    END IF;

    IF NEW."actorKind" = 'human' THEN
        expected_action := CASE
            WHEN newest_actor_kind = 'system' THEN 'amux.decision.latch_release'
            ELSE 'amux.decision.mode'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", expected_action, 'AmuxDecisionMakerSwitchEvent', NEW."id", NEW."actorUserId";
    ELSE
        expected_actor := CASE NEW."scope"
            WHEN 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.latch', 'AmuxDecisionMakerSwitchEvent', NEW."id", expected_actor;
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
