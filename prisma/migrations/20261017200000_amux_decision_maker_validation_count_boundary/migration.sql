-- AMUX Decision Maker (docs/policy/amux-decision-maker.md), section 8: where
-- an instance's validation count starts, stage S2-2a4. On the switch event
-- table, one nullable column; and one function body replaced, pinned to its
-- previous body below. No table is created and no existing row changes.
--
-- Section 8: "검증 실패(§6)가 연속 3건이면 그 인스턴스를 off로 latch한다.
-- 해제는 운영자만." Until this stage the application counted an instance's
-- failures from its newest switch event, a person's ordinary mode change
-- included, so saving the mode again between the third failure and its latch
-- dropped the latch without a release. The count now starts only at the
-- instance's newest validation latch -- nothing is owed while it stands -- or
-- at the first person's event after that latch, which this guard has always
-- required to be audited as amux.decision.latch_release. A mode change, a
-- cleanup latch and a cleanup latch's own release do not move it.
--
-- A result is placed before or after that release by the request ledger's
-- sequence, not by a clock: a failure that committed before the release can
-- share its database millisecond. Every switch event now records the newest
-- request ledger sequence committed before it ("ledgerSequence", 0 when the
-- ledger is empty), which the replaced guard sets on every insert as it sets
-- the event's clock, whatever the writer supplied; the count reads the
-- results whose sequence is above the release's.
--
-- Why that number is exact: the guard reads it after the switch gate, in a
-- statement of its own (under READ COMMITTED, which the guard already
-- requires, a snapshot taken after the lock was granted), in a transaction
-- holding the audit chain lock -- every switch event needs its audit row of
-- the same transaction, and every audit append takes that lock first
-- (lib/adminAudit.ts; the audit table's own trigger takes it for every hashed
-- entry). Every ledger event likewise needs its audit row of the same
-- transaction, so its transaction holds the same lock from before the event's
-- sequence is drawn until it commits. No ledger event is in flight while a
-- switch event is inserted: every one at or below the number committed before
-- it, and every later one commits after it with a higher sequence. This is the
-- same lock discipline the request store already relies on for the ledger's
-- sequence being the order its events committed in.
--
-- A switch event written before this migration has no number (NULL). The
-- application counts the results at or after such a release's database clock
-- instead, the comparison of stage S2-2a2: a result in the release's
-- millisecond is counted, the side that latches sooner.
--
-- The replaced body, its previous body with only these lines added:
--   amux_decision_maker_switch_event_guard (from
--     20261017160000_amux_decision_maker_cleanup_unknown): the ledger
--     sequence declared, read and set.
-- The DO block that opens the transaction pins it to the SHA-256 of its
-- previous body (pg_proc.prosrc, as scripts/baseline-presence-core.mjs
-- compares a replacement) and stops the migration on any other. The new
-- column makes this migration visible to the baseline guard's schema
-- comparison, so its header declares no probe.
--
-- The function pins search_path to pg_catalog, pg_temp and reads the tables
-- through TG_TABLE_SCHEMA, so no object earlier on a session's path can stand
-- in for them.
--
-- `prisma db push` creates no function. The DB integration suite runs on the
-- migration history, which is where this is tested
-- (tests/integration/amux-decision-maker-request.db.test.ts).
--
-- Rollback, in one transaction, after the application of this stage is rolled
-- back (its switch read selects the column): re-run the CREATE OR REPLACE
-- FUNCTION of 20261017160000_amux_decision_maker_cleanup_unknown, and drop the
-- column -- which discards where each release placed the ledger.

BEGIN;

-- The function this migration replaces must still be the exact body it was
-- written against, by the SHA-256 of pg_proc.prosrc: a hand edit or an
-- unknown version stops the migration before anything changes.
DO $pin$
DECLARE
    pinned RECORD;
    actual TEXT;
BEGIN
    FOR pinned IN
        SELECT * FROM (VALUES
            ('4f7f62b106a5e4afdc91e183db23af1d0f77b2f7030b564a5399a90ea38d28be', 'amux_decision_maker_switch_event_guard')
        ) AS pins("sha256", "name")
    LOOP
        SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
          INTO actual
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = pg_catalog.current_schema()
           AND p.proname = pinned."name"
           AND p.pronargs = 0
           AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;
        IF actual IS DISTINCT FROM pinned."sha256" THEN
            RAISE EXCEPTION 'AMUX_DM_UNEXPECTED_FUNCTION_BODY %', pinned."name";
        END IF;
    END LOOP;
END
$pin$;

-- Section 8: the newest request ledger sequence committed before the event.
-- The replaced guard sets it on every insert; a row from before this
-- migration keeps NULL.
ALTER TABLE "AmuxDecisionMakerSwitchEvent" ADD COLUMN "ledgerSequence" BIGINT;

-- The replaced function: its previous body with the lines the header lists
-- added and nothing else (tests/amuxDecisionMakerRequest.test.mjs compares
-- them line by line).

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
    named BOOLEAN;
    ledger_sequence BIGINT;
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
        'SELECT "sequence", "actorKind" FROM %I.%I WHERE "scope" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerSwitchEvent'
    ) INTO newest_sequence, newest_actor_kind USING NEW."scope";
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

    -- Stage S2-2a4, section 8: the newest request ledger event committed
    -- before this one, by the ledger's sequence (0 when there is none).
    -- Read after the switch gate, in a statement of its own, by a
    -- transaction holding the audit chain lock that every ledger write
    -- holds from its audit row to its commit: every ledger event at or
    -- below it committed before this event, and every later one commits
    -- after it.
    EXECUTE pg_catalog.format(
        'SELECT coalesce(max("sequence"), 0) FROM %I.%I',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO ledger_sequence;
    NEW."ledgerSequence" := ledger_sequence;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
