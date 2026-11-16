-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_switch_event_guard" "4f7f62b106a5e4afdc91e183db23af1d0f77b2f7030b564a5399a90ea38d28be" "74a53a1163f4212bae1b01306090757e812be156765a2306df622f977afb2266"
--
-- AMUX Decision Maker (docs/policy/amux-decision-maker.md §5, §8, §10): the
-- system releases an instance latch an hour after it wrote it (owner direction
-- 2026-11-16: "검증이 3번 연속 실패하면 꺼짐으로 고정되고, 사람만 풀 수 있습니다 ...
-- 일정 시간 뒤 자동으로 다시 켭니다").
--
-- What this makes irreversible: switch events the table refused before. Once
-- written, a system release cannot be updated or deleted (the guard refuses
-- both); it turns an instance back to proposal mode, and the request ledger
-- counts §8's validation failures again from it.
--
-- On the switch event table, two CHECKs replaced, and one function body
-- replaced, pinned to its previous body:
--
--   AmuxDecisionMakerSwitchEvent_reason_code_check: 'latch_release' joins
--     'operator', 'validation_latch' and 'cleanup_latch'.
--   AmuxDecisionMakerSwitchEvent_actor_reason_check: the system may also
--     write a release -- reason 'latch_release', an instance, value
--     'proposal' -- beside its two latches (an instance, value 'off').
--   amux_decision_maker_switch_event_guard (from
--     20261017160000_amux_decision_maker_cleanup_unknown): the newest event's
--     reason and clock are read with its actor; a person's change is a
--     release only after a system latch (no longer after any system event);
--     and a system release needs the scope's newest event to be a system
--     latch at least an hour old, the scope's newest person's event to be
--     proposal mode -- so an instance a person turned off is never turned on
--     -- and the instance's own system actor's amux.decision.latch_release of
--     the same transaction (tests/amuxDecisionMakerSwitch.test.mjs compares
--     the body line by line).
--
-- The release is the maintenance sweep's (lib/amux/decisionMakerRetentionSweep.ts),
-- through the switch store's one writer. Before this, only a person's
-- latch_release in Admin turned a latched instance on again.
--
-- Only lists grow, so every stored row passes the new CHECKs; no row changes.
-- The header pins the function body this was written against (pg_proc.prosrc's
-- SHA-256, scripts/baseline-presence-core.mjs) and the body it writes, and the
-- DO block stops the migration on any other.
--
-- Rollback, in one transaction: re-run the CREATE OR REPLACE FUNCTION of
-- 20261017160000_amux_decision_maker_cleanup_unknown and recreate both CHECKs
-- with their previous definitions -- which fails while a system release
-- remains, so a rollback after the first one means deciding what it was.

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
       AND p.proname = 'amux_decision_maker_switch_event_guard'
       AND p.pronargs = 0
       AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;
    IF actual IS DISTINCT FROM '4f7f62b106a5e4afdc91e183db23af1d0f77b2f7030b564a5399a90ea38d28be' THEN
        RAISE EXCEPTION 'AMUX_DM_UNEXPECTED_FUNCTION_BODY %', 'amux_decision_maker_switch_event_guard';
    END IF;
END
$pin$;

ALTER TABLE "AmuxDecisionMakerSwitchEvent"
  DROP CONSTRAINT "AmuxDecisionMakerSwitchEvent_reason_code_check",
  ADD CONSTRAINT "AmuxDecisionMakerSwitchEvent_reason_code_check"
    CHECK ("reasonCode" IN ('operator', 'validation_latch', 'cleanup_latch', 'latch_release'));

ALTER TABLE "AmuxDecisionMakerSwitchEvent"
  DROP CONSTRAINT "AmuxDecisionMakerSwitchEvent_actor_reason_check",
  ADD CONSTRAINT "AmuxDecisionMakerSwitchEvent_actor_reason_check"
    CHECK (
      ("actorKind" = 'human' AND "reasonCode" = 'operator')
      OR (
        "actorKind" = 'system'
        AND "reasonCode" IN ('validation_latch', 'cleanup_latch')
        AND "scope" <> 'kill_switch'
        AND "value" = 'off'
      )
      OR (
        "actorKind" = 'system'
        AND "reasonCode" = 'latch_release'
        AND "scope" <> 'kill_switch'
        AND "value" = 'proposal'
      )
    );

CREATE OR REPLACE FUNCTION "amux_decision_maker_switch_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    newest_sequence BIGINT;
    newest_actor_kind TEXT;
    newest_reason TEXT;
    newest_created_at TIMESTAMPTZ;
    operator_value TEXT;
    expected_action TEXT;
    expected_actor TEXT;
    audited BOOLEAN;
    named BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_IMMUTABLE';
    END IF;
    -- The newest event below is read after a lock. Only READ COMMITTED gives
    -- that read a snapshot taken after the lock was granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_ISOLATION';
    END IF;
    -- The switch gate, exclusive: no request ledger write that reads the
    -- switches is in flight while a switch changes.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
    );

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
        'SELECT "sequence", "actorKind", "reasonCode", "createdAt" FROM %I.%I WHERE "scope" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerSwitchEvent'
    ) INTO newest_sequence, newest_actor_kind, newest_reason, newest_created_at USING NEW."scope";
    IF newest_sequence IS NOT NULL AND NEW."sequence" <= newest_sequence THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_OUT_OF_ORDER';
    END IF;

    -- Stage S2-2a3, section 5: a cleanup latch names the cleanup_unknown
    -- report of its own instance that it settles. The CHECK requires the
    -- name on a cleanup latch and on nothing else, and the unique index
    -- one latch per report.
    IF NEW."cleanupEventId" IS NOT NULL THEN
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "kind" = ''cleanup_unknown'' AND "instance" = $2)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequestEvent'
        ) INTO named USING NEW."cleanupEventId", NEW."scope";
        IF named IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'AMUX_DM_SWITCH_CLEANUP_EVENT';
        END IF;
    END IF;

    IF NEW."actorKind" = 'human' THEN
        expected_action := CASE
            WHEN newest_actor_kind = 'system' AND newest_reason IN ('validation_latch', 'cleanup_latch') THEN 'amux.decision.latch_release'
            ELSE 'amux.decision.mode'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", expected_action, 'AmuxDecisionMakerSwitchEvent', NEW."id", NEW."actorUserId";
    ELSE
        -- Owner direction 2026-11-16: the system releases a latch it wrote
        -- itself, an hour after it, and only back to the proposal mode a
        -- person last chose: an instance a person turned off stays off, and
        -- a person's own change after the latch is a person's release.
        IF NEW."reasonCode" = 'latch_release' THEN
            EXECUTE pg_catalog.format(
                'SELECT "value" FROM %I.%I WHERE "scope" = $1 AND "actorKind" = ''human'' ORDER BY "sequence" DESC LIMIT 1',
                TG_TABLE_SCHEMA,
                'AmuxDecisionMakerSwitchEvent'
            ) INTO operator_value USING NEW."scope";
            IF newest_actor_kind IS DISTINCT FROM 'system'
               OR newest_reason IS NULL
               OR newest_reason NOT IN ('validation_latch', 'cleanup_latch')
               OR pg_catalog.clock_timestamp() < newest_created_at + INTERVAL '1 hour'
               OR operator_value IS DISTINCT FROM 'proposal' THEN
                RAISE EXCEPTION 'AMUX_DM_SWITCH_RELEASE';
            END IF;
        END IF;
        expected_actor := CASE NEW."scope"
            WHEN 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", CASE NEW."reasonCode" WHEN 'latch_release' THEN 'amux.decision.latch_release' ELSE 'amux.decision.latch' END, 'AmuxDecisionMakerSwitchEvent', NEW."id", expected_actor;
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_SWITCH_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
