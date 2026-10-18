-- AMUX Decision Maker (docs/policy/amux-decision-maker.md), section 8: where
-- an instance's validation count starts, stage S2-2a4. On the request event
-- table, one nullable column; and one function body replaced, pinned to its
-- previous body below. No table is created and no existing row changes.
--
-- Section 8: "검증 실패(§6)가 연속 3건이면 그 인스턴스를 off로 latch한다.
-- 해제는 운영자만." Until this stage the application counted an instance's
-- failures from its newest switch event, a person's ordinary mode change
-- included, so saving the mode again between the third failure and its latch
-- dropped the latch without a release. The count now starts only at the
-- instance's newest validation latch -- nothing is owed while it stands -- or
-- at the first person's event after that latch, which the switch guard has
-- always required to be audited as amux.decision.latch_release. A mode change,
-- a cleanup latch and a cleanup latch's own release do not move it.
--
-- A result is placed before or after that release by the switch state it was
-- admitted under, not by a clock and not by the ledger's sequence. Every
-- result now records ("switchSequence") the sequence of its instance's newest
-- switch event, which the replaced guard reads after the shared switch gate it
-- already takes for every result; the count after a release reads the results
-- whose number is at or above the release's own sequence.
--
-- Why that is exact without the audit chain lock (review
-- r-20261018-012448-8f45bd): a switch event's guard takes the same gate
-- exclusive and holds it to its commit, and a result's guard holds it shared
-- to its commit. A release therefore commits wholly before a result's read --
-- which then sees it, or a later event of the scope -- or wholly after the
-- result, which then cannot see it. A scope's events commit in the order of
-- their sequences (the switch guard refuses one numbered below the newest), so
-- the comparison with the release's sequence is that order. A clock cannot
-- tell a failure from a release in the same millisecond, and the ledger's
-- sequence is drawn when an INSERT starts, before its guard waits on the gate:
-- a failure can draw N, wait on a release, and commit after it while another
-- request's assignment, which takes no gate, commits N + 1 before it. An audit
-- row with no entry hash takes no chain lock to serialize them.
--
-- A result written before this migration has no number (NULL). The
-- application places such a result by its database clock instead, at or after
-- the release's, the comparison of stage S2-2a2: a shared millisecond counts,
-- the side that latches sooner.
--
-- The replaced body, its previous body with only these lines added:
--   amux_decision_maker_request_event_guard (from
--     20261017160000_amux_decision_maker_cleanup_unknown): the admitted switch
--     sequence declared, read for a result and set on every event.
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
-- back (its result reads select the column): re-run the CREATE OR REPLACE
-- FUNCTION of 20261017160000_amux_decision_maker_cleanup_unknown, and drop the
-- column -- which discards which switch state each result was admitted under.

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
            ('19f17a91c87e7f3d4989724e5ecbf430b29796a111a138adfa790dcc6c8476c9', 'amux_decision_maker_request_event_guard')
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

-- Section 8: the sequence of its instance's newest switch event a result was
-- admitted under. The replaced guard sets it on every event (NULL but for a
-- result); a row from before this migration keeps NULL.
ALTER TABLE "AmuxDecisionMakerRequestEvent" ADD COLUMN "switchSequence" BIGINT;

-- The replaced function: its previous body with the lines the header lists
-- added and nothing else (tests/amuxDecisionMakerRequest.test.mjs compares
-- them line by line).

CREATE OR REPLACE FUNCTION "amux_decision_maker_request_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_route TEXT;
    request_instance TEXT;
    request_created_at TIMESTAMPTZ;
    request_assignment_deadline TIMESTAMPTZ;
    newest_sequence BIGINT;
    assigned BOOLEAN;
    result_deadline TIMESTAMPTZ;
    transmitted BOOLEAN;
    intent_payload TEXT;
    transmit_settled BOOLEAN;
    has_result BOOLEAN;
    terminal_digest TEXT;
    terminal_kind TEXT;
    has_result_unknown BOOLEAN;
    has_cleanup_unknown BOOLEAN;
    closed BOOLEAN;
    now_at TIMESTAMPTZ;
    allowed BOOLEAN;
    expected_actor TEXT;
    audited BOOLEAN;
    kill_switch_value TEXT;
    instance_mode TEXT;
    kill_on BOOLEAN := false;
    switch_refused BOOLEAN := false;
    admitted_switch_sequence BIGINT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_IMMUTABLE';
    END IF;
    -- The request's events and the switches are read after locks. Only READ
    -- COMMITTED gives those reads a snapshot taken after the locks were granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_ISOLATION';
    END IF;

    -- The switch gate, shared, before the per-request lock (the lock order of
    -- every Decision Maker write). A switch change takes it exclusive, so the
    -- switches read below cannot change before this event commits.
    IF NEW."kind" IN ('transmit_intent', 'result', 'result_rejected') THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
    END IF;

    -- One event per request at a time, so the state read below is still the
    -- state when this one commits. The writer already holds the audit chain
    -- lock; this lock is the database's own and does not rely on that.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );

    EXECUTE pg_catalog.format(
        'SELECT "route", "instance", "createdAt", "assignmentDeadlineAt" FROM %I.%I WHERE "id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequest'
    ) INTO request_route, request_instance, request_created_at, request_assignment_deadline
    USING NEW."requestId";
    IF request_route IS NULL THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_NO_REQUEST';
    END IF;

    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT max("sequence"),
                coalesce(bool_or("kind" = ''assign''), false),
                max("resultDeadlineAt"),
                coalesce(bool_or("kind" = ''transmit_intent''), false),
                max("inputPayloadDigest") FILTER (WHERE "kind" = ''transmit_intent''),
                coalesce(bool_or("kind" IN (''transmit_receipt'', ''transmit_unknown'')), false),
                coalesce(bool_or("kind" = ''result''), false),
                max("resultDigest") FILTER (WHERE "kind" = ''result''),
                max("resultKind") FILTER (WHERE "kind" = ''result''),
                coalesce(bool_or("kind" = ''result_unknown''), false),
                coalesce(bool_or("kind" = ''cleanup_unknown''), false),
                coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'', ''confirm'', ''edit_confirm'', ''reject'')), false)
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO newest_sequence, assigned, result_deadline, transmitted, intent_payload,
           transmit_settled, has_result, terminal_digest, terminal_kind, has_result_unknown, has_cleanup_unknown, closed
    USING NEW."requestId";
    IF newest_sequence IS NOT NULL AND NEW."sequence" <= newest_sequence THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_OUT_OF_ORDER';
    END IF;

    -- A request routed to the operator is closed from its creation.
    closed := closed OR request_route = 'operator';
    now_at := pg_catalog.clock_timestamp();

    -- An event that names an instance names the request's own.
    IF NEW."instance" IS NOT NULL AND NEW."instance" IS DISTINCT FROM request_instance THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_INSTANCE';
    END IF;

    -- Section 6's table and section 8, by the switch store's newest events (no
    -- event: the kill switch off, the instance off): a transmission intent
    -- needs the kill switch off and the instance in proposal mode, a proposal
    -- needs the kill switch off, and a rejection citing the kill switch needs
    -- it on.
    IF NEW."kind" = 'transmit_intent'
       OR (NEW."kind" = 'result' AND NEW."resultKind" = 'proposal')
       OR (NEW."kind" = 'result_rejected' AND NEW."rejectionReason" = 'kill_switch') THEN
        EXECUTE pg_catalog.format(
            'SELECT (SELECT "value" FROM %1$I.%2$I WHERE "scope" = ''kill_switch'' ORDER BY "sequence" DESC LIMIT 1),'
            || ' (SELECT "value" FROM %1$I.%2$I WHERE "scope" = $1 ORDER BY "sequence" DESC LIMIT 1)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerSwitchEvent'
        ) INTO kill_switch_value, instance_mode USING request_instance;
        kill_on := coalesce(kill_switch_value, 'off') <> 'off';
        switch_refused :=
            (NEW."kind" = 'transmit_intent' AND (kill_on OR coalesce(instance_mode, 'off') <> 'proposal'))
            OR (NEW."kind" = 'result' AND kill_on);
    END IF;

    allowed := CASE NEW."kind"
        WHEN 'assign' THEN
            request_route = 'dm_proposal' AND NOT closed AND NOT assigned
        WHEN 'assign_discarded' THEN
            assigned AND NOT closed AND NOT transmitted AND NOT has_result AND NOT has_result_unknown
        WHEN 'transmit_intent' THEN
            assigned AND NOT closed AND NOT transmitted AND NOT has_result AND NOT has_result_unknown
        WHEN 'transmit_receipt' THEN
            transmitted AND NOT transmit_settled
        WHEN 'transmit_unknown' THEN
            transmitted AND NOT transmit_settled
        WHEN 'result' THEN
            assigned AND NOT closed AND NOT has_result AND NOT has_result_unknown
            AND (transmitted OR NEW."resultKind" = 'unavailable')
            AND NEW."inputPayloadDigest" IS NOT DISTINCT FROM intent_payload
        WHEN 'result_rejected' THEN
            CASE NEW."rejectionReason"
                WHEN 'request_closed' THEN closed
                WHEN 'terminal_exists' THEN has_result AND NEW."resultDigest" IS DISTINCT FROM terminal_digest
                WHEN 'result_unknown' THEN has_result_unknown
                WHEN 'not_transmitted' THEN NOT transmitted
                WHEN 'deadline_passed' THEN
                    assigned AND now_at >= result_deadline - INTERVAL '200 milliseconds'
                WHEN 'kill_switch' THEN kill_on
                -- binding_mismatch is decided from the submission, which the
                -- ledger does not keep.
                ELSE true
            END
        WHEN 'result_unknown' THEN
            assigned AND NOT closed AND NOT has_result AND NOT has_result_unknown
        -- Stage S2-2a3, section 5: the broker could not confirm that the
        -- request's directories were deleted. Once per request, after the
        -- assignment that gave the broker the request; a fact whatever
        -- happened since, so also once the request is closed. It closes
        -- nothing.
        WHEN 'cleanup_unknown' THEN
            assigned AND NOT has_cleanup_unknown
        -- Stage S1e: a person's judgment of the request's proposal closes it,
        -- once. The judgment table's own trigger writes these, in the
        -- judgment's statement.
        WHEN 'confirm' THEN
            request_route = 'dm_proposal' AND NOT closed AND terminal_kind = 'proposal'
        WHEN 'edit_confirm' THEN
            request_route = 'dm_proposal' AND NOT closed AND terminal_kind = 'proposal'
        WHEN 'reject' THEN
            request_route = 'dm_proposal' AND NOT closed AND terminal_kind = 'proposal'
        WHEN 'stale_close' THEN
            NOT closed AND now_at >= request_created_at + INTERVAL '720 hours'
        ELSE false
    END;
    IF allowed IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_TRANSITION';
    END IF;

    -- The deadlines by this clock, less the 200 ms commit reserve: the same D
    -- the deferred check below holds the COMMIT to.
    IF (NEW."kind" = 'assign' AND now_at >= request_assignment_deadline - INTERVAL '200 milliseconds')
       OR (
         (NEW."kind" = 'transmit_intent'
          OR (NEW."kind" = 'result' AND NEW."resultKind" IN ('proposal', 'escalate', 'validation_failure')))
         AND now_at >= result_deadline - INTERVAL '200 milliseconds'
       ) THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_DEADLINE';
    END IF;
    IF switch_refused THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_SWITCH';
    END IF;

    IF NEW."kind" IN ('confirm', 'edit_confirm', 'reject') THEN
        -- A person's judgment (stage S1e): the judgment row of this
        -- transaction for this request, of this kind and named by this audit
        -- row, which is the person's amux.decision.<kind> of this
        -- transaction targeting the request and naming it in its metadata --
        -- the audit stage S1d's body guard binds an edited answer to.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %1$I.%2$I j JOIN %1$I.%3$I a ON a."id" = j."auditLogId" WHERE j."requestId" = $1 AND j."kind" = $2 AND j."auditLogId" = $3 AND j.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.'' || j."kind" AND a."targetType" = ''AmuxDecisionMakerRequest'' AND a."targetId" = j."requestId" AND a."actorUserId" = j."actorUserId" AND pg_catalog.jsonb_typeof(a."metadata") = ''object'' AND NOT (a."metadata" ? ''systemActor'') AND a."metadata" ->> ''request_id'' = j."requestId" AND a.xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerJudgment',
            'AdminAuditLog'
        ) INTO audited USING NEW."requestId", NEW."kind", NEW."auditLogId";
    ELSE
        expected_actor := CASE
            WHEN NEW."kind" IN ('assign', 'assign_discarded', 'stale_close') THEN 'amux-decision-router'
            WHEN request_instance = 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN request_instance = 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.' || NEW."kind", 'AmuxDecisionMakerRequestEvent', NEW."id", expected_actor;
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_UNAUDITED';
    END IF;

    -- Stage S2-2a4, section 8: a result records the newest switch event of
    -- its instance it was admitted under (0 when there is none), read after
    -- the shared switch gate taken above, in a statement of its own. A
    -- switch change takes the gate exclusive, so a latch's release commits
    -- wholly before this result, which then reads the release or a later
    -- event, or wholly after it -- whatever sequence either drew, and with
    -- or without the audit chain lock. Every other kind records none,
    -- whatever the writer supplied.
    IF NEW."kind" = 'result' THEN
        EXECUTE pg_catalog.format(
            'SELECT coalesce(max("sequence"), 0) FROM %I.%I WHERE "scope" = $1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerSwitchEvent'
        ) INTO admitted_switch_sequence USING request_instance;
    END IF;
    NEW."switchSequence" := admitted_switch_sequence;

    NEW."createdAt" := now_at;
    IF NEW."kind" = 'assign' THEN
        NEW."resultDeadlineAt" := NEW."createdAt" + INTERVAL '30 minutes';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
