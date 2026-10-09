-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_request_event_guard" "38eccc48c014792476f474cc0543f4fab860d24d6497bfbd0fae05c7eb38745e"
-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- section 10: "열린 요청은 생성 30일 뒤 stale로 닫으므로". The S1d review's
-- follow-up. Replaces one function body; no table, column, constraint, trigger
-- or row changes.
--
-- The request event guard of 20261008090100_amux_decision_maker_request_ledger
-- allowed a stale close at the request's creation plus a 30-day interval. On
-- timestamptz an interval counted in days follows the session time zone's
-- calendar, so across a daylight-saving change that boundary moves by an hour:
-- it falls 719 or 721 hours after the creation. The application counts exactly
-- 30 x 86,400,000 ms (DM_STALE_CLOSE_AFTER_MS in
-- lib/amux/decisionMakerRequestCore.ts), so for such a request the writer and
-- the guard disagreed for that hour: the store refused a close the guard would
-- have accepted, or sent one the guard then refused, aborting the caller's
-- transaction. The S1d body store already counts its retention in hours (2160)
-- for the same reason.
--
-- This changes that one interval to '720 hours', a fixed length, and nothing
-- else: every other line is the S1c body unchanged. Section 10's 120-day
-- ceiling on a body without a hold (a stale close at 30 days plus 90 days'
-- retention) is now exact by the database clock as well.
--
-- Rollback: re-run the CREATE OR REPLACE FUNCTION of migration
-- 20261008090100_amux_decision_maker_request_ledger, which restores the
-- calendar interval.

BEGIN;

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
    has_result_unknown BOOLEAN;
    closed BOOLEAN;
    now_at TIMESTAMPTZ;
    allowed BOOLEAN;
    expected_actor TEXT;
    audited BOOLEAN;
    kill_switch_value TEXT;
    instance_mode TEXT;
    kill_on BOOLEAN := false;
    switch_refused BOOLEAN := false;
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
                coalesce(bool_or("kind" = ''result_unknown''), false),
                coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'')), false)
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO newest_sequence, assigned, result_deadline, transmitted, intent_payload,
           transmit_settled, has_result, terminal_digest, has_result_unknown, closed
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
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_EVENT_UNAUDITED';
    END IF;

    NEW."createdAt" := now_at;
    IF NEW."kind" = 'assign' THEN
        NEW."resultDeadlineAt" := NEW."createdAt" + INTERVAL '30 minutes';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
