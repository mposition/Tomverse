-- AMUX Decision Maker (docs/policy/amux-decision-maker.md), sections 2-7, 6,
-- 9 and 10: the delivery path's remaining gaps, stage S2-2b4. On the request
-- event table, the kind CHECK and the instance/kind CHECK replaced, the
-- one-closing index replaced and the S1d closing trigger recreated with a
-- wider WHEN; on the delivery event table, one nullable column, the kind
-- CHECK replaced, two new CHECKs and the one-outcome index replaced; and six
-- existing function bodies replaced, each pinned to its previous body below.
-- No table is created and no existing row changes.
--
-- What this makes irreversible: two kinds of append-only row the ledger never
-- held. Once written, neither can be updated or deleted (the guards refuse
-- both), and each ends what it closes -- a request closed by a direct answer
-- takes no judgment, no body and no result; a decision recorded as not sent
-- takes no receipt, no unknown outcome and no second decision.
--
-- 1. A request's close by the operator's direct answer (section 2-7:
--    "운영자의 직접 답이 먼저면 요청은 닫힌다"). The local AMUX writes the
--    answer record of a question revision before anything is sent, and the
--    operator's direct answer and a confirmed DM answer claim the same record
--    (stage S2-2b3). When the bridge finds the operator's record for a
--    question, the router closes that question's open request with the new
--    closing kind direct_answer_close -- once, from any open state: not yet
--    assigned, assigned, transmitted, or holding a result or an unknown result.
--    A request routed to the operator is closed from its creation. Closed, a
--    request takes no judgment (the replaced judgment guard), so a proposal the
--    operator did not confirm can never be confirmed and delivered after the
--    operator answered; a late result is rejected as request_closed, as for
--    every closed request; and the closing trigger starts its retention.
--    Section 10 closes its list of audit actions and names none for this
--    close, so it is the router's amux.decision.assign_discarded -- the action
--    section 2-3 gives the close of a request whose card the operator answered
--    first -- told apart by the event's kind and the audit metadata's kind, as
--    a delivery receipt is recorded under .deliver. The kind joins every list
--    of closing kinds: the event guard, the body guard, the retention guard
--    (which reads the action through that mapping), the digest key guard, the
--    judgment guard, the one-closing index and the closing trigger, and the
--    request store's four reads (AGENTS.md, stage S1e: a list is never changed
--    on one side only).
--
-- 2. A decided delivery that sent nothing (sections 2-7 and 9). Stage S2-2b3
--    had no word for a delivery decision after which the local AMUX proved
--    that nothing was sent -- the operator's direct answer won the answer
--    record's claim, the question or section 9's binding changed, or the lane
--    refused before typing -- so the decision stayed without an outcome and the
--    relay halted. The new delivery kind delivery_not_sent is the decision's
--    third outcome, beside the receipt and the unknown outcome, one of the
--    three once (the one-outcome index), with its reason from a closed list
--    exactly on that kind (two CHECKs). A delivery whose result is not proved
--    stays delivery_unknown (section 9) and is never not_sent. It records what
--    already happened, so it is allowed under the kill switch, as the other
--    outcomes are. Section 10 names no action of its own for it either: it is
--    the router's amux.decision.deliver, as the receipt is, with its reason in
--    the audit metadata.
--
-- The six replaced bodies, each its previous body with only these lines
-- changed:
--   amux_decision_maker_request_event_guard (from
--     20261017200000_amux_decision_maker_validation_count_boundary): the
--     closing aggregate takes direct_answer_close, the graph allows it on an
--     open request routed to a DM, and its audit is the router's under
--     amux.decision.assign_discarded.
--   amux_decision_maker_body_guard (from
--     20261008130100_amux_decision_maker_judgment_delivery): a direct
--     answer's close closes the request for a body as well.
--   amux_decision_maker_retention_event_guard (same): a retention_set may be
--     named by a direct answer's close and the router's
--     amux.decision.assign_discarded naming it.
--   amux_decision_maker_digest_key_event_guard (same): a request closed by a
--     direct answer is not open when a key period's destruction counts them.
--   amux_decision_maker_judgment_guard (same): a request closed by a direct
--     answer takes no judgment.
--   amux_decision_maker_delivery_event_guard (same): delivery_not_sent counts
--     as the outcome and is allowed once after the decision.
-- The DO block that opens the transaction pins each to the SHA-256 of its
-- previous body (pg_proc.prosrc, as scripts/baseline-presence-core.mjs
-- compares a replacement) and stops the migration on any other. The new
-- column makes this migration visible to the baseline guard's schema
-- comparison, so its header declares no probe.
--
-- Every function pins search_path to pg_catalog, pg_temp and reads and writes
-- the tables through TG_TABLE_SCHEMA, so no object earlier on a session's path
-- can stand in for them. All guards still read after a lock and refuse any
-- isolation level but READ COMMITTED; the lock order is unchanged.
--
-- `prisma db push` creates no function, trigger, CHECK or partial index. The
-- DB integration suite runs on the migration history, which is where all of
-- them are tested (tests/integration/amux-decision-maker-delivery.db.test.ts).
--
-- Rollback, in one transaction, after the application of this stage is rolled
-- back: re-run the six CREATE OR REPLACE FUNCTION statements of their previous
-- migrations, recreate the closing trigger and the two indexes and the three
-- replaced CHECKs with their previous definitions, drop the two new CHECKs and
-- the column -- which fails while a direct answer's close or a not-sent
-- outcome remains, so a rollback after the first of either means deciding what
-- those requests are. Nothing writes either kind while
-- TOMVERSE_AMUX_DM_ROUTING is not enabled: the routes answer 409 before they
-- read their body.

BEGIN;

-- Each function this migration replaces must still be the exact body it was
-- written against, by the SHA-256 of pg_proc.prosrc, as the baseline guard
-- compares a replacement (scripts/baseline-presence-core.mjs). A header admits
-- one baseline declaration and this migration replaces six, so the pins are
-- checked here, on every apply: a hand edit or an unknown version stops the
-- migration before anything changes.
DO $pin$
DECLARE
    pinned RECORD;
    actual TEXT;
BEGIN
    FOR pinned IN
        SELECT * FROM (VALUES
            ('f3cec310ef748b74192f7e278bcf8b08db6a4d923f0ccbc0d101c99c18d49678', 'amux_decision_maker_request_event_guard'),
            ('eddb3aedb19ff46a4aa43dfb7ec9532f63431df1fb88901d6848a02369986ffb', 'amux_decision_maker_body_guard'),
            ('8fa31e9f2a016cb7304426923198a0b9bc2da793ad071ab6288c7d757f68b876', 'amux_decision_maker_retention_event_guard'),
            ('589c9f498a2f5fad5e83ed880d9014ec114b5a1199095601bbd7a9daf6839ad9', 'amux_decision_maker_digest_key_event_guard'),
            ('df2ddfa94405bd040228e4eb1bd68864bd043b59256184a9d16a7e1404df08c5', 'amux_decision_maker_judgment_guard'),
            ('03caed49b01b1390fbc33a504770256a12fcdd625afe3b0207c19e562eaf301a', 'amux_decision_maker_delivery_event_guard')
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

-- Section 2-7: a direct answer's close joins the request event kinds, on the
-- no-instance side of the instance rule (the router's), and the closing kinds:
-- the one-closing index takes it, so a request is closed once whatever closes
-- it, and the S1d closing trigger starts its retention.
ALTER TABLE "AmuxDecisionMakerRequestEvent"
  DROP CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check",
  ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"
    CHECK ("kind" IN (
      'assign', 'assign_discarded', 'transmit_intent', 'transmit_receipt', 'transmit_unknown',
      'result', 'result_rejected', 'result_unknown', 'stale_close', 'cleanup_unknown', 'direct_answer_close',
      'confirm', 'edit_confirm', 'reject'
    ));
ALTER TABLE "AmuxDecisionMakerRequestEvent"
  DROP CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check",
  ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check"
    CHECK (((
      "kind" IN ('assign', 'assign_discarded', 'stale_close', 'direct_answer_close', 'confirm', 'edit_confirm', 'reject')
    ) = ("instance" IS NULL)) IS TRUE);

DROP INDEX "AmuxDecisionMakerRequestEvent_one_closing_key";
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_closing_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" IN ('assign_discarded', 'stale_close', 'direct_answer_close', 'confirm', 'edit_confirm', 'reject');

DROP TRIGGER "amux_decision_maker_request_closing_retention" ON "AmuxDecisionMakerRequestEvent";
CREATE TRIGGER "amux_decision_maker_request_closing_retention"
    AFTER INSERT ON "AmuxDecisionMakerRequestEvent"
    FOR EACH ROW
    WHEN (NEW."kind" IN ('assign_discarded', 'stale_close', 'direct_answer_close', 'confirm', 'edit_confirm', 'reject'))
    EXECUTE FUNCTION "amux_decision_maker_request_closing_retention"();

-- Sections 2-7 and 9: a decided delivery that sent nothing joins the delivery
-- kinds as the third outcome, with its reason from a closed list exactly on
-- that kind; the one-outcome index takes it, so a decision has one outcome of
-- the three.
ALTER TABLE "AmuxDecisionMakerDeliveryEvent" ADD COLUMN "notSentReason" TEXT;
ALTER TABLE "AmuxDecisionMakerDeliveryEvent"
  DROP CONSTRAINT "AmuxDecisionMakerDeliveryEvent_kind_check",
  ADD CONSTRAINT "AmuxDecisionMakerDeliveryEvent_kind_check"
    CHECK ("kind" IN ('deliver', 'delivery_receipt', 'delivery_unknown', 'delivery_unknown_resolve', 'delivery_not_sent'));
ALTER TABLE "AmuxDecisionMakerDeliveryEvent"
  ADD CONSTRAINT "AmuxDecisionMakerDeliveryEvent_not_sent_reason_check"
    CHECK ("notSentReason" IS NULL OR "notSentReason" IN ('answered_by_operator', 'question_changed', 'binding_changed', 'lane_refused', 'local_refused'));
ALTER TABLE "AmuxDecisionMakerDeliveryEvent"
  ADD CONSTRAINT "AmuxDecisionMakerDeliveryEvent_not_sent_shape_check"
    CHECK ((("kind" = 'delivery_not_sent') = ("notSentReason" IS NOT NULL)) IS TRUE);

DROP INDEX "AmuxDecisionMakerDeliveryEvent_one_outcome_key";
CREATE UNIQUE INDEX "AmuxDecisionMakerDeliveryEvent_one_outcome_key"
  ON "AmuxDecisionMakerDeliveryEvent"("requestId") WHERE "kind" IN ('delivery_receipt', 'delivery_unknown', 'delivery_not_sent');

-- The six replaced functions. Each is its previous body with the lines the
-- header lists changed and nothing else (tests/amuxDecisionMakerJudgment.test.mjs
-- compares them line by line).

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
                coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject'')), false)
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
        NEW."resultDeadlineAt" := NEW."createdAt" + INTERVAL '30 minutes';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_decision_maker_body_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_route TEXT;
    request_instance TEXT;
    request_created_at TIMESTAMPTZ;
    request_audit TEXT;
    closed BOOLEAN;
    registered_check TEXT;
    destroyed BOOLEAN;
    held BOOLEAN;
    retention_until TIMESTAMPTZ;
    request_bytes BIGINT;
    audited BOOLEAN;
    expected_actor TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_IMMUTABLE';
    END IF;
    -- The request's state is read after its lock.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_ISOLATION';
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- The request's lock: its holds, its close and its other body writes
        -- commit before or after this delete, never beside it.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || OLD."requestId")
        );
        EXECUTE pg_catalog.format(
            'SELECT count(*) FILTER (WHERE "kind" = ''hold_set'') > count(*) FILTER (WHERE "kind" = ''hold_release''), max("retentionUntil") FROM %I.%I WHERE "requestId" = $1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRetentionEvent'
        ) INTO held, retention_until USING OLD."requestId";
        -- Section 10: no delete under an open hold, erase included.
        IF held THEN
            RAISE EXCEPTION 'AMUX_DM_BODY_HELD';
        END IF;
        -- (1) The expiry purge: the router's audit of this transaction, after the retention.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetType" = $2 AND "targetId" = $3 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $4 AND pg_catalog.jsonb_typeof("metadata" -> ''fields'') = ''array'' AND ("metadata" -> ''fields'') ? $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING 'amux.decision.body_purge', 'AmuxDecisionMakerRequest', OLD."requestId", 'amux-decision-router', OLD."field";
        IF audited THEN
            IF retention_until IS NULL OR pg_catalog.clock_timestamp() < retention_until THEN
                RAISE EXCEPTION 'AMUX_DM_BODY_RETAINED';
            END IF;
            RETURN OLD;
        END IF;
        -- (2) The privacy erase: a person's audit of this transaction.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "action" = $1 AND "targetType" = $2 AND "targetId" = $3 AND "actorUserId" IS NOT NULL AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND pg_catalog.jsonb_typeof("metadata" -> ''fields'') = ''array'' AND ("metadata" -> ''fields'') ? $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING 'amux.decision.body_erase', 'AmuxDecisionMakerRequest', OLD."requestId", OLD."field";
        IF audited THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'AMUX_DM_BODY_DELETE_UNAUDITED';
    END IF;

    -- Stage S1e: an operator's answer is written for an edited confirmation,
    -- whose judgment reads the kill switch under the Decision Maker switch
    -- gate. Every Decision Maker write takes that gate before the request
    -- lock, so the answer takes it first, shared. It reads no switch here.
    IF NEW."field" = 'operator_answer' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );
    EXECUTE pg_catalog.format(
        'SELECT "route", "instance", "createdAt", "auditLogId" FROM %I.%I WHERE "id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequest'
    ) INTO request_route, request_instance, request_created_at, request_audit USING NEW."requestId";
    IF request_route IS NULL THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_NO_REQUEST';
    END IF;
    -- Open and routed to a DM: a request routed to the operator is closed from
    -- its creation, and a closed one gains no body. Since stage S1e a person's
    -- judgment closes it too, so an edited answer is stored before its
    -- judgment, in the same transaction, and nothing after it. Since stage
    -- S2-2b4 an operator's direct answer closes it as well.
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1 AND "kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject''))',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO closed USING NEW."requestId";
    IF request_route <> 'dm_proposal' OR closed THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_CLOSED';
    END IF;
    -- The key period of the request's creation, whose key digests everything of it.
    IF NEW."keyPeriod" <> pg_catalog.floor(EXTRACT(EPOCH FROM request_created_at) * 1000 / 2592000000)::INTEGER THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_KEY_PERIOD';
    END IF;

    -- Shared: a destruction of this period (exclusive) commits before this
    -- read, or waits for this body and then sees it.
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtext('tomverse-amux-decision-maker-key-period:' || NEW."keyPeriod"::text)
    );
    EXECUTE pg_catalog.format(
        'SELECT max("keyCheck") FILTER (WHERE "kind" = ''rotate''), coalesce(bool_or("kind" = ''destroy''), false) FROM %I.%I WHERE "keyPeriod" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerDigestKeyEvent'
    ) INTO registered_check, destroyed USING NEW."keyPeriod";
    IF registered_check IS DISTINCT FROM NEW."keyCheck" OR destroyed THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_KEY';
    END IF;

    -- Section 10: "요청당 합계는 40 KiB 이하다". Rows of the same statement
    -- written before this one are visible here.
    EXECUTE pg_catalog.format(
        'SELECT coalesce(sum(pg_catalog.octet_length("text")), 0) FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerBody'
    ) INTO request_bytes USING NEW."requestId";
    IF request_bytes + pg_catalog.octet_length(NEW."text") > 40960 THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_REQUEST_SIZE';
    END IF;

    -- What the body belongs to, written by this very transaction.
    IF NEW."field" = 'card_text' THEN
        -- The card as routed: the request row's own route audit.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.route', 'AmuxDecisionMakerRequest', NEW."requestId", 'amux-decision-router';
        audited := audited AND NEW."auditLogId" = request_audit;
    ELSIF NEW."field" IN ('dm_answer', 'dm_rationale', 'dm_escalation_reason') THEN
        -- The DM's output: the request's result of the matching kind, and its
        -- own result audit by the request's instance.
        expected_actor := CASE request_instance
            WHEN 'decision-maker-openai' THEN 'amux-decision-maker-openai'
            WHEN 'decision-maker-anthropic' THEN 'amux-decision-maker-anthropic'
        END;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %1$I.%2$I e JOIN %1$I.%3$I a ON a."id" = e."auditLogId" WHERE e."auditLogId" = $1 AND e."requestId" = $2 AND e."kind" = ''result'' AND e."resultKind" = $3 AND e.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.result'' AND a."targetType" = ''AmuxDecisionMakerRequestEvent'' AND a."targetId" = e."id" AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND pg_catalog.jsonb_typeof(a."metadata") = ''object'' AND a."metadata" ->> ''systemActor'' = $4 AND a.xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequestEvent',
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", NEW."requestId",
            CASE WHEN NEW."field" = 'dm_escalation_reason' THEN 'escalate' ELSE 'proposal' END,
            expected_actor;
    ELSIF NEW."field" = 'operator_answer' THEN
        -- The operator's edited answer: a person's edit_confirm targeting the
        -- request and naming it in its metadata.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NOT NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND NOT ("metadata" ? ''systemActor'') AND "metadata" ->> ''request_id'' = $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.edit_confirm', 'AmuxDecisionMakerRequest', NEW."requestId";
    ELSE
        -- Not one of the five: the field CHECK refuses it as well.
        audited := false;
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_BODY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_decision_maker_retention_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_created_at TIMESTAMPTZ;
    newest_sequence BIGINT;
    has_retention BOOLEAN;
    hold_sets BIGINT;
    hold_releases BIGINT;
    closed_at TIMESTAMPTZ;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_RETENTION_IMMUTABLE';
    END IF;
    -- The request's retention events are read after its lock.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_RETENTION_ISOLATION';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );
    EXECUTE pg_catalog.format(
        'SELECT "createdAt" FROM %I.%I WHERE "id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequest'
    ) INTO request_created_at USING NEW."requestId";
    IF request_created_at IS NULL THEN
        RAISE EXCEPTION 'AMUX_DM_RETENTION_NO_REQUEST';
    END IF;
    IF NEW."keyPeriod" <> pg_catalog.floor(EXTRACT(EPOCH FROM request_created_at) * 1000 / 2592000000)::INTEGER THEN
        RAISE EXCEPTION 'AMUX_DM_RETENTION_KEY_PERIOD';
    END IF;
    -- A hold keeps its period's key; shared against a destruction's exclusive.
    IF NEW."kind" <> 'retention_set' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-key-period:' || NEW."keyPeriod"::text)
        );
    END IF;

    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT max("sequence"), coalesce(bool_or("kind" = ''retention_set''), false), count(*) FILTER (WHERE "kind" = ''hold_set''), count(*) FILTER (WHERE "kind" = ''hold_release'') FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRetentionEvent'
    ) INTO newest_sequence, has_retention, hold_sets, hold_releases USING NEW."requestId";
    IF newest_sequence IS NOT NULL AND NEW."sequence" <= newest_sequence THEN
        RAISE EXCEPTION 'AMUX_DM_RETENTION_OUT_OF_ORDER';
    END IF;

    IF NEW."kind" = 'retention_set' THEN
        IF has_retention THEN
            RAISE EXCEPTION 'AMUX_DM_RETENTION_TRANSITION';
        END IF;
        -- The request's closing event of this transaction, named by its own
        -- audit of this transaction: the router's amux.decision.<kind> naming
        -- the event for assign_discarded and stale_close, or since stage S1e
        -- the person's amux.decision.<kind> naming the request for a
        -- judgment, or since stage S2-2b4 the router's
        -- amux.decision.assign_discarded naming the event for a direct
        -- answer's close (section 10 names no action of its own for it).
        -- The retention starts at the close.
        EXECUTE pg_catalog.format(
            'SELECT e."createdAt" FROM %1$I.%2$I e JOIN %1$I.%3$I a ON a."id" = e."auditLogId" WHERE e."auditLogId" = $1 AND e."requestId" = $2 AND e.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.'' || CASE e."kind" WHEN ''direct_answer_close'' THEN ''assign_discarded'' ELSE e."kind" END AND pg_catalog.jsonb_typeof(a."metadata") = ''object'' AND a.xmin = pg_catalog.pg_current_xact_id()::xid AND ('
            || '(e."kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'') AND a."targetType" = ''AmuxDecisionMakerRequestEvent'' AND a."targetId" = e."id" AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND a."metadata" ->> ''systemActor'' = ''amux-decision-router'')'
            || ' OR (e."kind" IN (''confirm'', ''edit_confirm'', ''reject'') AND a."targetType" = ''AmuxDecisionMakerRequest'' AND a."targetId" = e."requestId" AND a."actorUserId" IS NOT NULL AND NOT (a."metadata" ? ''systemActor''))'
            || ')',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequestEvent',
            'AdminAuditLog'
        ) INTO closed_at USING NEW."auditLogId", NEW."requestId";
        IF closed_at IS NULL THEN
            RAISE EXCEPTION 'AMUX_DM_RETENTION_UNAUDITED';
        END IF;
        NEW."retentionUntil" := closed_at + INTERVAL '2160 hours';
    ELSE
        -- Section 10: a hold is set only when none is open, released only when one is.
        IF (NEW."kind" = 'hold_set' AND hold_sets > hold_releases)
           OR (NEW."kind" = 'hold_release' AND hold_sets <= hold_releases) THEN
            RAISE EXCEPTION 'AMUX_DM_RETENTION_TRANSITION';
        END IF;
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.legal_hold', 'AmuxDecisionMakerRetentionEvent', NEW."id", NEW."actorUserId";
        IF audited IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'AMUX_DM_RETENTION_UNAUDITED';
        END IF;
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_decision_maker_digest_key_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    rotated BOOLEAN;
    destroyed BOOLEAN;
    current_period INTEGER;
    remaining BIGINT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_IMMUTABLE';
    END IF;
    -- The period's events, bodies, holds and requests are read after the lock.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_ISOLATION';
    END IF;
    -- Exclusive: a body insert or a hold event of this period, which take it
    -- shared, either committed before the reads below or waits for this event.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-key-period:' || NEW."keyPeriod"::text)
    );

    EXECUTE pg_catalog.format(
        'SELECT coalesce(bool_or("kind" = ''rotate''), false), coalesce(bool_or("kind" = ''destroy''), false) FROM %I.%I WHERE "keyPeriod" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerDigestKeyEvent'
    ) INTO rotated, destroyed USING NEW."keyPeriod";
    current_period := pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000 / 2592000000)::INTEGER;

    IF NEW."kind" = 'rotate' THEN
        -- Once, never after its destruction, no further ahead than the next period.
        IF rotated OR destroyed OR NEW."keyPeriod" > current_period + 1 THEN
            RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_TRANSITION';
        END IF;
    ELSE
        -- Once, after its rotation, and only once the period has ended.
        IF NOT rotated OR destroyed OR NEW."keyPeriod" >= current_period THEN
            RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_TRANSITION';
        END IF;
        -- Section 10: every body row of the period is gone.
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %I.%I WHERE "keyPeriod" = $1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerBody'
        ) INTO remaining USING NEW."keyPeriod";
        IF remaining > 0 THEN
            RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_BODIES';
        END IF;
        -- Section 10: no hold is open on a request of the period.
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM (SELECT "requestId" FROM %I.%I WHERE "keyPeriod" = $1 AND "kind" IN (''hold_set'', ''hold_release'') GROUP BY "requestId" HAVING count(*) FILTER (WHERE "kind" = ''hold_set'') > count(*) FILTER (WHERE "kind" = ''hold_release'')) held',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRetentionEvent'
        ) INTO remaining USING NEW."keyPeriod";
        IF remaining > 0 THEN
            RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_HELD';
        END IF;
        -- A body can still be stored for an open request, so none of the
        -- period's requests routed to a DM may be open. Since stage S1e a
        -- person's judgment closes a request as well, and since stage S2-2b4
        -- an operator's direct answer.
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %1$I.%2$I r WHERE r."route" = ''dm_proposal'''
            || ' AND r."createdAt" >= pg_catalog.to_timestamp($1::double precision * 2592000)'
            || ' AND r."createdAt" < pg_catalog.to_timestamp(($1 + 1)::double precision * 2592000)'
            || ' AND NOT EXISTS (SELECT 1 FROM %1$I.%3$I e WHERE e."requestId" = r."id" AND e."kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject''))',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequest',
            'AmuxDecisionMakerRequestEvent'
        ) INTO remaining USING NEW."keyPeriod";
        IF remaining > 0 THEN
            RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_OPEN_REQUESTS';
        END IF;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.decision.digest_key_' || NEW."kind", 'AmuxDecisionMakerDigestKeyEvent', NEW."id", 'amux-decision-router';
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_DIGEST_KEY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_decision_maker_judgment_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_route TEXT;
    request_instance TEXT;
    closed BOOLEAN;
    result_id TEXT;
    result_kind TEXT;
    intent_state TEXT;
    intent_sha TEXT;
    intent_manifest TEXT;
    detail_found BOOLEAN;
    detail_output_kind TEXT;
    detail_option_id TEXT;
    detail_irreversible BOOLEAN;
    answer_digest TEXT;
    rationale_digest TEXT;
    operator_digest TEXT;
    operator_own BOOLEAN;
    kill_switch_value TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_IMMUTABLE';
    END IF;
    -- The request's events, bodies and the switches are read after locks.
    -- Only READ COMMITTED gives those reads a snapshot taken after the locks
    -- were granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_ISOLATION';
    END IF;
    -- Section 4: each mismatched item once. A NULL element is not counted
    -- here; the mismatched items CHECK refuses it.
    IF (SELECT pg_catalog.count(item) FROM pg_catalog.unnest(NEW."mismatchedItems") AS item)
       <> (SELECT pg_catalog.count(DISTINCT item) FROM pg_catalog.unnest(NEW."mismatchedItems") AS item) THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_ACCURACY';
    END IF;

    -- The switch gate, shared, before the request lock: a confirmation reads
    -- the kill switch below, and a switch change takes the gate exclusive.
    IF NEW."kind" IN ('confirm', 'edit_confirm') THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
    END IF;
    -- The request's lock, which every ledger event, body and retention event
    -- of the request takes: its state below is still its state at COMMIT.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );

    EXECUTE pg_catalog.format(
        'SELECT "route", "instance" FROM %I.%I WHERE "id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequest'
    ) INTO request_route, request_instance USING NEW."requestId";
    IF request_route IS NULL THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_NO_REQUEST';
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT coalesce(bool_or("kind" IN (''assign_discarded'', ''stale_close'', ''direct_answer_close'', ''confirm'', ''edit_confirm'', ''reject'')), false),
                max("id") FILTER (WHERE "kind" = ''result''),
                max("resultKind") FILTER (WHERE "kind" = ''result''),
                max("snapshotState") FILTER (WHERE "kind" = ''transmit_intent''),
                max("snapshotTargetSha") FILTER (WHERE "kind" = ''transmit_intent''),
                max("snapshotManifestDigest") FILTER (WHERE "kind" = ''transmit_intent'')
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO closed, result_id, result_kind, intent_state, intent_sha, intent_manifest USING NEW."requestId";
    -- Section 6: "운영자의 확정은 요청이 열려 있고". A request routed to the
    -- operator is closed from its creation, and an earlier judgment closed it.
    -- Since stage S2-2b4 an operator's direct answer closes it too.
    IF request_route <> 'dm_proposal' OR closed THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_CLOSED';
    END IF;
    -- The request's one terminal result is a proposal, and the judgment names it.
    IF result_kind IS DISTINCT FROM 'proposal' OR result_id IS DISTINCT FROM NEW."resultEventId" THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_NO_PROPOSAL';
    END IF;
    IF NEW."instance" IS DISTINCT FROM request_instance THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_INSTANCE';
    END IF;
    -- The proposal's S1d detail, written with the result.
    EXECUTE pg_catalog.format(
        'SELECT true, "outputKind", "optionId", "irreversible" FROM %I.%I WHERE "resultEventId" = $1 AND "requestId" = $2 AND "resultKind" = ''proposal''',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerResultDetail'
    ) INTO detail_found, detail_output_kind, detail_option_id, detail_irreversible
    USING NEW."resultEventId", NEW."requestId";
    IF detail_found IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_NO_PROPOSAL';
    END IF;

    -- Section 6's table: no confirmation under the kill switch, read under the
    -- gate (no event: off). A rejection stays allowed.
    IF NEW."kind" IN ('confirm', 'edit_confirm') THEN
        EXECUTE pg_catalog.format(
            'SELECT "value" FROM %I.%I WHERE "scope" = ''kill_switch'' ORDER BY "sequence" DESC LIMIT 1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerSwitchEvent'
        ) INTO kill_switch_value;
        IF coalesce(kill_switch_value, 'off') <> 'off' THEN
            RAISE EXCEPTION 'AMUX_DM_JUDGMENT_SWITCH';
        END IF;
    END IF;

    -- The request's bodies, as they stand now: the DM's answer and rationale,
    -- and an operator's answer and whether this transaction wrote it under
    -- this judgment's audit row.
    EXECUTE pg_catalog.format(
        'SELECT max("digest") FILTER (WHERE "field" = ''dm_answer''),
                max("digest") FILTER (WHERE "field" = ''dm_rationale''),
                max("digest") FILTER (WHERE "field" = ''operator_answer''),
                coalesce(bool_or("field" = ''operator_answer'' AND "auditLogId" = $2 AND xmin = pg_catalog.pg_current_xact_id()::xid), false)
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerBody'
    ) INTO answer_digest, rationale_digest, operator_digest, operator_own USING NEW."requestId", NEW."auditLogId";
    -- Section 6: "운영자가 고친 답은 새 본문 행이 되고 그 digest가 판정에
    -- 기록된다". An edit_confirm names the answer it wrote; a confirm or a
    -- rejection stands only with no operator answer stored.
    IF (NEW."kind" = 'edit_confirm' AND (operator_own AND operator_digest IS NOT DISTINCT FROM NEW."operatorAnswerDigest") IS NOT TRUE)
       OR (NEW."kind" <> 'edit_confirm' AND operator_digest IS NOT NULL) THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_OPERATOR_ANSWER';
    END IF;
    -- Section 6: "Admin이 보여 준 제안 본문과 스냅샷 정보의 digest가 저장된
    -- 값과 같을 때만". Every value Admin showed equals the stored one: the
    -- rationale (a proposal always has one), the free-text answer exactly when
    -- the proposal is free text, the select's option, the irreversible flag,
    -- and the transmission's snapshot. A body erased since cannot be confirmed.
    IF NEW."kind" IN ('confirm', 'edit_confirm') AND (
        rationale_digest IS NOT NULL
        AND NEW."shownRationaleDigest" IS NOT DISTINCT FROM rationale_digest
        AND NEW."shownAnswerDigest" IS NOT DISTINCT FROM answer_digest
        AND (detail_output_kind IS NOT DISTINCT FROM 'free_text') = (NEW."shownAnswerDigest" IS NOT NULL)
        AND NEW."shownOptionId" IS NOT DISTINCT FROM detail_option_id
        AND NEW."shownIrreversible" IS NOT DISTINCT FROM detail_irreversible
        AND NEW."shownSnapshotState" IS NOT DISTINCT FROM intent_state
        AND NEW."shownSnapshotTargetSha" IS NOT DISTINCT FROM intent_sha
        AND NEW."shownSnapshotManifestDigest" IS NOT DISTINCT FROM intent_manifest
    ) IS NOT TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_SHOWN';
    END IF;

    -- A person's amux.decision.<kind> of this transaction, targeting the
    -- request and naming it in its metadata -- the audit the S1d body guard
    -- binds an edited answer to -- by the person the judgment names.
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND NOT ("metadata" ? ''systemActor'') AND "metadata" ->> ''request_id'' = $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.decision.' || NEW."kind", 'AmuxDecisionMakerRequest', NEW."requestId", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_JUDGMENT_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_decision_maker_delivery_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    judgment_kind TEXT;
    newest_sequence BIGINT;
    delivered BOOLEAN;
    settled BOOLEAN;
    unknown_outcome BOOLEAN;
    resolved BOOLEAN;
    allowed BOOLEAN;
    kill_switch_value TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_DELIVERY_IMMUTABLE';
    END IF;
    -- The judgment, the request's delivery events and the switches are read
    -- after locks. Only READ COMMITTED gives those reads a snapshot taken
    -- after the locks were granted.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_DELIVERY_ISOLATION';
    END IF;
    -- The switch gate, shared, before the request lock: the decision reads
    -- the kill switch below.
    IF NEW."kind" = 'deliver' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtext('tomverse-amux-decision-maker-switch-gate')
        );
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-decision-maker-request:' || NEW."requestId")
    );

    EXECUTE pg_catalog.format(
        'SELECT "kind" FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerJudgment'
    ) INTO judgment_kind USING NEW."requestId";
    -- A separate statement after the lock: under READ COMMITTED it reads what
    -- a transaction the lock waited for has committed.
    EXECUTE pg_catalog.format(
        'SELECT max("sequence"),
                coalesce(bool_or("kind" = ''deliver''), false),
                coalesce(bool_or("kind" IN (''delivery_receipt'', ''delivery_unknown'', ''delivery_not_sent'')), false),
                coalesce(bool_or("kind" = ''delivery_unknown''), false),
                coalesce(bool_or("kind" = ''delivery_unknown_resolve''), false)
           FROM %I.%I WHERE "requestId" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerDeliveryEvent'
    ) INTO newest_sequence, delivered, settled, unknown_outcome, resolved USING NEW."requestId";
    IF newest_sequence IS NOT NULL AND NEW."sequence" <= newest_sequence THEN
        RAISE EXCEPTION 'AMUX_DM_DELIVERY_OUT_OF_ORDER';
    END IF;

    -- Sections 2-7 and 9: the decision once, after a confirmation; then a
    -- receipt, an unknown outcome or (stage S2-2b4) a delivery that sent
    -- nothing, one of the three once; then, after an
    -- unknown outcome only, one person's resolution. A rejection is never
    -- delivered.
    allowed := CASE NEW."kind"
        WHEN 'deliver' THEN
            judgment_kind IN ('confirm', 'edit_confirm') AND NOT delivered
        WHEN 'delivery_receipt' THEN
            delivered AND NOT settled
        WHEN 'delivery_unknown' THEN
            delivered AND NOT settled
        -- Stage S2-2b4: the local AMUX proved the decided delivery sent
        -- nothing; its reason is the row's, held by the CHECKs.
        WHEN 'delivery_not_sent' THEN
            delivered AND NOT settled
        WHEN 'delivery_unknown_resolve' THEN
            unknown_outcome AND NOT resolved
        ELSE false
    END;
    IF allowed IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_DELIVERY_TRANSITION';
    END IF;

    -- Section 6's table: "bridge의 확정 답 조회·전달 — 거부" under the kill
    -- switch. Only the decision releases an answer; an outcome records what
    -- already happened, and the resolution is a person's operation.
    IF NEW."kind" = 'deliver' THEN
        EXECUTE pg_catalog.format(
            'SELECT "value" FROM %I.%I WHERE "scope" = ''kill_switch'' ORDER BY "sequence" DESC LIMIT 1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerSwitchEvent'
        ) INTO kill_switch_value;
        IF coalesce(kill_switch_value, 'off') <> 'off' THEN
            RAISE EXCEPTION 'AMUX_DM_DELIVERY_SWITCH';
        END IF;
    END IF;

    IF NEW."kind" = 'delivery_unknown_resolve' THEN
        -- A person's amux.decision.delivery_unknown_resolve of this
        -- transaction, naming the event, by the person the event names.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId", 'amux.decision.delivery_unknown_resolve', 'AmuxDecisionMakerDeliveryEvent', NEW."id", NEW."actorUserId";
    ELSE
        -- The router's amux.decision.deliver (the decision, the receipt and,
        -- since stage S2-2b4, a not-sent outcome)
        -- or amux.decision.delivery_unknown of this transaction, naming the
        -- event, with no person.
        EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" IS NULL AND "actorEmail" IS NULL AND "ipAddress" IS NULL AND "userAgent" IS NULL AND pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ->> ''systemActor'' = $5 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
            TG_TABLE_SCHEMA,
            'AdminAuditLog'
        ) INTO audited USING NEW."auditLogId",
            CASE NEW."kind" WHEN 'delivery_unknown' THEN 'amux.decision.delivery_unknown' ELSE 'amux.decision.deliver' END,
            'AmuxDecisionMakerDeliveryEvent', NEW."id", 'amux-decision-router';
    END IF;
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_DELIVERY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
