-- baseline-check: replace-function-if-body-sha256 "amux_decision_maker_request_event_guard" "1c3c0a8c374bac1c9b0257aaf4f470b272c0699616457a2ccb9446435c88279f"
-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- sections 5 and 10: a request whose directories the broker could not confirm
-- deleted, stage S2-2a3. On the request event table, the kind CHECK replaced,
-- two partial indexes added and the event guard's body replaced, pinned to
-- its previous body above. No table, column or trigger is created, and no
-- existing row changes.
--
-- Section 5: "지웠는지 확인하지 못하면 cleanup_unknown으로 두고 그 인스턴스를
-- off로 latch한다". The request's state is a new event kind, cleanup_unknown,
-- named after its section 10 audit action, amux.decision.cleanup_unknown. The
-- latch is the switch store's own system event (reason cleanup_latch, which
-- the switch CHECK has held since 20261008030000_amux_decision_maker_switch),
-- written by the application in a transaction of its own after this event
-- commits; until then the request store refuses a routing and a transmission
-- intent of the instance as if it were off (the owed latch of section 8). The
-- database does not look for an owed latch, as it does not for section 8's.
--
-- What the database enforces, rather than the application:
--
-- * The event's kind is one of thirteen: the S1c nine, cleanup_unknown, and a
--   person's three judgment kinds.
-- * It names the request's own instance (the instance/kind CHECK already
--   requires an instance for every kind but the router's and a judgment's),
--   carries nothing else (the existing column CHECKs), and its audit row is
--   amux.decision.cleanup_unknown of the same transaction, naming the event,
--   by that instance's system actor -- the event guard's existing rule for
--   every kind but the router's and a judgment's.
-- * It is accepted once per request (a partial unique index, and the guard)
--   and only after the request's assignment: the broker builds the request
--   directory only for an assigned request, before the transmission intent,
--   so it may have one to delete even when no intent was recorded. It is a
--   fact about local files, so -- like a transmission receipt -- it is also
--   accepted after the request closed, after a result and under the kill
--   switch, and holds no deadline.
-- * It does not close the request. Section 6 names five terminal results and
--   a person's judgment closes a proposal; a cleanup that could not be
--   confirmed is neither. A proposal stored before the report stays open for
--   the operator, and a report arriving after a judgment, a stale close or a
--   discarded assignment is still recorded, which a closing kind under the
--   one-closing index could not be. So the closing kinds, the one-closing
--   index, the retention trigger and every guard that reads the closing kinds
--   are unchanged.
-- * A second partial index, on the instance and the clock of cleanup_unknown
--   events only, keeps the request store's read of an instance's newest report
--   (the owed latch) to an index lookup.
--
-- The one replaced body is its previous body (20261008130100_amux_decision_maker_judgment_delivery)
-- with these lines added and nothing else: the cleanup_unknown flag declared
-- and read with the rest of the request's events, and the cleanup_unknown
-- transition. The header pins that previous body by the SHA-256 of
-- pg_proc.prosrc, as the baseline guard compares a replacement
-- (scripts/baseline-presence-core.mjs).
--
-- The function pins search_path to pg_catalog, pg_temp and reads the tables
-- through TG_TABLE_SCHEMA, so no object earlier on a session's path can stand
-- in for them.
--
-- `prisma db push` creates none of the CHECKs, partial indexes or functions.
-- The DB integration suite runs on the migration history, which is where they
-- are tested (tests/integration/amux-decision-maker-request.db.test.ts).
--
-- Rollback, in one transaction: re-run the CREATE OR REPLACE FUNCTION of
-- 20261008130100_amux_decision_maker_judgment_delivery, drop the two indexes,
-- and replace the kind CHECK with its 20261008130100 definition -- which
-- fails while a cleanup_unknown event remains, so a rollback after the first
-- report means deciding what those requests are.

BEGIN;

ALTER TABLE "AmuxDecisionMakerRequestEvent"
  DROP CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check",
  ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"
    CHECK ("kind" IN (
      'assign', 'assign_discarded', 'transmit_intent', 'transmit_receipt', 'transmit_unknown',
      'result', 'result_rejected', 'result_unknown', 'stale_close', 'cleanup_unknown',
      'confirm', 'edit_confirm', 'reject'
    ));

-- Section 5: one report per request.
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_cleanup_unknown_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'cleanup_unknown';
-- An instance's newest report, which the owed latch reads.
CREATE INDEX "AmuxDecisionMakerRequestEvent_cleanup_unknown_instance_idx"
  ON "AmuxDecisionMakerRequestEvent"("instance", "createdAt") WHERE "kind" = 'cleanup_unknown';

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

    NEW."createdAt" := now_at;
    IF NEW."kind" = 'assign' THEN
        NEW."resultDeadlineAt" := NEW."createdAt" + INTERVAL '30 minutes';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
