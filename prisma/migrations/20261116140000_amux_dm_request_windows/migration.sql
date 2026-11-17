-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_request_event_guard" "e3bfad84ab8387c0ddaa4302532ea7b8f0c2cd5d6e5cb840391d1c8b0d865d05" "f626eb52520fe7b43bd6ea1b53be2d6321b8ec99c5d372c948489594906db051"
--
-- AMUX Decision Maker (docs/policy/amux-decision-maker.md §2, §9, §10):
-- the request ledger's windows, and a late result read back by its digest
-- (owner direction 2026-11-16: "결과 창 30분 ... 다시 읽고 다시 보냅니다. 창은
-- 넉넉하게 늘리고").
--
-- What this makes irreversible: result events the ledger refused before. Once
-- written, a result accepted after the request's result_unknown cannot be
-- updated or deleted (the guard refuses both), and it is the request's one
-- terminal result: the operator judges it as any other.
--
-- Two function bodies replaced, each its previous body with only these lines
-- changed (tests/amuxDecisionMakerRequest.test.mjs compares them line by line):
--
--   amux_decision_maker_request_guard (from
--     20261008090100_amux_decision_maker_request_ledger): the assignment
--     deadline is the request's creation plus 24 hours (was 2 minutes).
--   amux_decision_maker_request_event_guard (from
--     20261018120000_amux_decision_maker_delivery_gaps): the result deadline
--     is the assignment plus 8 hours (was 30 minutes); the digest a
--     result_unknown names is read with the rest of the request's events, and
--     a result of that digest is accepted after it -- once, open, before the
--     deadline, naming the intent, as every result -- and a rejection citing
--     result_unknown needs another digest.
--
-- A relay that lost a result's answer records it unknown, reads the
-- (request, digest) pair back and submits it again on every tick
-- (apps/tomverse-orchestrator/src/dm_relay/owed.rs). Before this, no later
-- result was accepted and the operator alone answered the card.
--
-- Not changed: the 720-hour stale close. It is the retention rule of §10 --
-- an open request is closed 30 days after its creation, so a body lives at
-- most 120 days without a hold -- and a request left open would keep its key
-- period's key and bodies for good (the digest key guard refuses to destroy a
-- period with an open request). The commit-time check
-- (amux_decision_maker_request_event_commit_check) reads the stored
-- deadlines and is unchanged; rows written before this keep the deadlines
-- they were given.
--
-- The header pins the event guard's body this was written against (pg_proc.prosrc's
-- SHA-256, scripts/baseline-presence-core.mjs) and the body it writes; the DO
-- block below pins both bodies and stops the migration on any other.
--
-- Rollback, in one transaction: re-run the CREATE OR REPLACE FUNCTION of both
-- previous migrations. A result already accepted after an unknown stays.

BEGIN;

DO $pin$
DECLARE
    pinned RECORD;
    actual TEXT;
BEGIN
    FOR pinned IN
        SELECT * FROM (VALUES
            ('84541060974020bb79fb2c4a304a7bcafddcff4faa4a03b85f155bebdaa3a47b', 'amux_decision_maker_request_guard'),
            ('e3bfad84ab8387c0ddaa4302532ea7b8f0c2cd5d6e5cb840391d1c8b0d865d05', 'amux_decision_maker_request_event_guard')
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

CREATE OR REPLACE FUNCTION "amux_decision_maker_request_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    audited BOOLEAN;
    kill_switch_value TEXT;
    instance_mode TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_IMMUTABLE';
    END IF;
    -- The switches below are read after the gate. Only READ COMMITTED gives
    -- that read a snapshot taken after the gate was granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_ISOLATION';
    END IF;
    -- routeDmQuestion() records each refusal once. A NULL element is not
    -- counted here; the refusal codes CHECK refuses it.
    IF (SELECT pg_catalog.count(code) FROM pg_catalog.unnest(NEW."refusalCodes") AS code)
       <> (SELECT pg_catalog.count(DISTINCT code) FROM pg_catalog.unnest(NEW."refusalCodes") AS code) THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_REFUSALS';
    END IF;

    -- Section 6, section 8: no question is routed to a DM while the kill
    -- switch is on or its instance is not in proposal mode. The switch store's
    -- newest events, read under the gate the switch guard takes exclusive; a
    -- scope with no event is the kill switch off and an instance off.
    IF NEW."route" = 'dm_proposal' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
        EXECUTE pg_catalog.format(
            'SELECT (SELECT "value" FROM %1$I.%2$I WHERE "scope" = ''kill_switch'' ORDER BY "sequence" DESC LIMIT 1),'
            || ' (SELECT "value" FROM %1$I.%2$I WHERE "scope" = $1 ORDER BY "sequence" DESC LIMIT 1)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerSwitchEvent'
        ) INTO kill_switch_value, instance_mode USING NEW."instance";
        IF coalesce(kill_switch_value, 'off') <> 'off' OR coalesce(instance_mode, 'off') <> 'proposal' THEN
            RAISE EXCEPTION 'AMUX_DM_REQUEST_SWITCH';
        END IF;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.decision.route', 'AmuxDecisionMakerRequest', NEW."id", 'amux-decision-router';
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_REQUEST_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    -- Owner direction 2026-11-16: a day to take the assignment (it was two
    -- minutes), so a relay that was down or slow still takes the request.
    NEW."assignmentDeadlineAt" := NEW."createdAt" + INTERVAL '24 hours';
    RETURN NEW;
END;
$$;

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
    unknown_digest TEXT;
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
                max("resultDigest") FILTER (WHERE "kind" = ''result_unknown''),
                coalesce(bool_or("kind" = ''cleanup_unknown''), false),
                coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject'')), false)
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO newest_sequence, assigned, result_deadline, transmitted, intent_payload,
           transmit_settled, has_result, terminal_digest, terminal_kind, has_result_unknown, unknown_digest, has_cleanup_unknown, closed
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
        -- Owner direction 2026-11-16: a result whose answer the submitter
        -- lost, and which it recorded as unknown, is accepted when it comes
        -- again with the digest the unknown names -- the read-back that
        -- proves it is the same output -- inside the same deadline.
        WHEN 'result' THEN
            assigned AND NOT closed AND NOT has_result
            AND (NOT has_result_unknown OR NEW."resultDigest" IS NOT DISTINCT FROM unknown_digest)
            AND (transmitted OR NEW."resultKind" = 'unavailable')
            AND NEW."inputPayloadDigest" IS NOT DISTINCT FROM intent_payload
        WHEN 'result_rejected' THEN
            CASE NEW."rejectionReason"
                WHEN 'request_closed' THEN closed
                WHEN 'terminal_exists' THEN has_result AND NEW."resultDigest" IS DISTINCT FROM terminal_digest
                WHEN 'result_unknown' THEN has_result_unknown AND NEW."resultDigest" IS DISTINCT FROM unknown_digest
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
        -- Stage S2-2b4, section 2-7: "운영자의 직접 답이 먼저면 요청은
        -- 닫힌다". The bridge reports that the local AMUX's answer record
        -- names the operator for the request's question; the router closes
        -- the request once, whatever it was waiting for. A request routed to
        -- the operator is closed from its creation.
        WHEN 'direct_answer_close' THEN
            request_route = 'dm_proposal' AND NOT closed
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
        -- Section 10 closes its list of actions and names none for a direct
        -- answer's close (stage S2-2b4): it is the router's
        -- amux.decision.assign_discarded, the action section 2-3 gives the
        -- close of a request whose card the operator answered first, told
        -- apart by the event's kind and the audit metadata's kind.
        expected_actor := CASE
            WHEN NEW."kind" IN ('assign', 'assign_discarded', 'stale_close', 'direct_answer_close') THEN 'amux-decision-router'
            WHEN request_instance = 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN request_instance = 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.' || CASE NEW."kind" WHEN 'direct_answer_close' THEN 'assign_discarded' ELSE NEW."kind" END, 'AmuxDecisionMakerRequestEvent', NEW."id", expected_actor;
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
        -- Owner direction 2026-11-16: eight hours (it was 30 minutes), past
        -- the broker's answer deadline (3 hours 4 minutes).
        NEW."resultDeadlineAt" := NEW."createdAt" + INTERVAL '8 hours';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
