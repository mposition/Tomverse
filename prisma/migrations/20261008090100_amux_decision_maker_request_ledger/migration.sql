-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- sections 2, 6, 9 and 10: the request ledger, stage S1c. Additive only: two
-- new tables, three functions and three triggers. No existing row, column or
-- constraint changes, and nothing here writes a row.
--
-- AmuxDecisionMakerRequest holds one row per routed question -- per (card id,
-- question revision), §9 -- with the binding values known when it was routed
-- and the router's decision. AmuxDecisionMakerRequestEvent is the request's
-- append-only lifecycle, ordered by "sequence"; a request's state is what its
-- events add up to (§10: "상태는 새 행으로 남기며"). Neither table holds a
-- body: identifiers, closed codes and opaque 64-hex digests only (§10:
-- "본문은 원장에 넣지 않는다"). Whether a digest is keyed, and by which key
-- period, is the digest-key stage's decision; the ledger stores it as given.
--
-- What the database enforces, rather than the application:
--
-- * The request's route is operator or dm_proposal; its instance is the one
--   the asking provider maps to (claude -> decision-maker-openai, codex ->
--   decision-maker-anthropic, §7) or none for any other provider; every
--   refusal code is one routeDmQuestion() records, once each; dm_proposal
--   carries no refusal and operator at least one; and provider_unverified is
--   recorded exactly when there is no instance. The request's audit row is the
--   router's amux.decision.route, written by this very transaction, naming
--   the request. "createdAt" is the database clock of the insert and
--   "assignmentDeadlineAt" that plus 2 minutes (§2-1). (card id, question
--   revision) is unique.
-- * An event's kind is one of nine, each named after its §10 audit action:
--   assign, assign_discarded, transmit_intent, transmit_receipt,
--   transmit_unknown, result, result_rejected, result_unknown, stale_close.
--   Its audit row is amux.decision.<kind>, of this transaction, naming the
--   event, by the router (amux-decision-router) for assign, assign_discarded
--   and stale_close, and by the request's own instance
--   (amux-decision-maker-openai or -anthropic) for every other kind.
-- * The transition graph, checked by the guard trigger under a per-request
--   advisory lock (the same graph is dmEventRefusal() in
--   lib/amux/decisionMakerRequestCore.ts):
--     assign            request routed to a DM, open, not yet assigned, and
--                       before its assignment deadline less the 200 ms commit
--                       reserve; sets "resultDeadlineAt" = its clock + 30 min;
--     assign_discarded  assigned, open, nothing since; closes the request;
--     transmit_intent   assigned, open, not yet transmitted, no result, no
--                       unknown result, before the result deadline less the
--                       reserve, and the switches allow it (below); one per
--                       request (§10: never sent again);
--     transmit_receipt / transmit_unknown
--                       after the intent, one of the two, even once closed;
--     result            assigned, open, no result, no unknown result; every
--                       kind but unavailable needs the intent and names its
--                       payload digest; a DM output (proposal, escalate,
--                       validation_failure) only before the result deadline
--                       less the reserve; one per request (§6, §9);
--     result_rejected   any time, from the request's instance, with a reason
--                       the ledger's state or the switches bear out where
--                       they can (all but binding_mismatch);
--     result_unknown    assigned, open, no result, no earlier unknown;
--     stale_close       open, 30 days after creation; closes the request.
--   A request routed to the operator is closed from its creation, so only a
--   rejection can be recorded against it. Partial unique indexes back each
--   "one per request".
-- * The deadlines are the database's at COMMIT as well as at the insert: a
--   deferred constraint trigger raises SQLSTATE AX001 -- the AmuxCommitDeadline
--   device's code (20260929200000_amux_commit_deadline_check), so the AMUX
--   boundary reads it as a deadline refusal -- once the clock at COMMIT has
--   reached the assignment deadline, or for a transmission intent or a DM
--   output the result deadline, less the 200 ms reserve. The intent is held
--   to it because its row is the authorization to send the card, which is
--   never sent again: an intent that commits after the result deadline would
--   send a card whose answer can no longer be accepted. The writer also hands
--   the same deadline to the boundary's fence, which records D for that
--   device; this trigger is what holds a writer outside the boundary to it
--   (§9: "검사 시점에 마감을 넘긴 결과는 DB가 제안으로 기록하지 않는다").
-- * The switches, section 6's table and section 8: nothing that would let a
--   DM run or a proposal stand is recorded while the kill switch is on or the
--   instance is not in proposal mode, by the switch store's own newest events
--   (no event: kill switch off, instance off). A request routed dm_proposal
--   and a transmission intent need the kill switch off and the instance in
--   proposal; a proposal result needs the kill switch off; a rejection that
--   cites the kill switch needs it on. Both guards read the switches under the
--   Decision Maker switch gate, taken shared, which the switch guard takes
--   exclusive (20261008090000_amux_decision_maker_switch_serialization): a
--   switch change and these writes commit one after the other, never on a
--   stale read. Lock order: the audit chain lock (every store path takes it
--   first), the gate, then the per-request lock.
-- * Both guards, and an event's "sequence" above every earlier event of its
--   request, as in the switch store. Both guards read after a lock -- the
--   gate, and for events the per-request lock -- so both refuse any isolation
--   level but READ COMMITTED
--   (20261008090000_amux_decision_maker_switch_serialization explains why).
--   The commit check reads only rows that cannot change, so it needs no such
--   check.
-- * UPDATE and DELETE are refused on both tables. TRUNCATE is not, for the
--   reasons the switch store gives (20261008030000_amux_decision_maker_switch):
--   the DB integration suites reset AdminAuditLog with TRUNCATE ... CASCADE,
--   which reaches both tables through their foreign keys.
--
-- Every function pins search_path to pg_catalog, pg_temp and reads the tables
-- through TG_TABLE_SCHEMA, so no object earlier on a session's path can stand
-- in for them.
--
-- `prisma db push` creates the tables and none of the functions, triggers,
-- CHECKs or partial indexes. The DB integration suite runs on the migration
-- history (scripts/run-db-integration-tests.mjs), which is where all of them
-- are tested (tests/integration/amux-decision-maker-request.db.test.ts).
--
-- Rollback: drop the three triggers, the three functions, then the event table
-- and the request table (their foreign keys go with them; AdminAuditLog is not
-- changed). That discards the request ledger. Nothing reads it yet: no route,
-- Admin screen or DM process exists in this stage.

BEGIN;

CREATE TABLE "AmuxDecisionMakerRequest" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "questionRevision" INTEGER NOT NULL,
    "askingWorkerId" TEXT NOT NULL,
    "amuxSessionId" TEXT NOT NULL,
    "amuxSessionAttempt" INTEGER NOT NULL,
    "askingProvider" TEXT NOT NULL,
    "optionSetDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "termListVersion" TEXT NOT NULL,
    "classificationVersion" TEXT NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "instance" TEXT,
    "refusalCodes" TEXT[],
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignmentDeadlineAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AmuxDecisionMakerRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerRequest_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerRequest_identifier_format_check"
      CHECK (
        "cardId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "askingWorkerId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "amuxSessionId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      ),
    CONSTRAINT "AmuxDecisionMakerRequest_counter_check"
      CHECK ("questionRevision" >= 0 AND "amuxSessionAttempt" >= 0),
    CONSTRAINT "AmuxDecisionMakerRequest_asking_provider_format_check"
      CHECK ("askingProvider" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    CONSTRAINT "AmuxDecisionMakerRequest_option_set_digest_format_check"
      CHECK ("optionSetDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AmuxDecisionMakerRequest_version_check"
      CHECK (
        "policyVersion" >= 1
        AND "termListVersion" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
        AND "classificationVersion" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
        AND "scannerVersion" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      ),
    CONSTRAINT "AmuxDecisionMakerRequest_route_check"
      CHECK ("route" IN ('operator', 'dm_proposal')),
    CONSTRAINT "AmuxDecisionMakerRequest_instance_check"
      CHECK ("instance" IS NULL OR "instance" IN ('decision-maker-openai', 'decision-maker-anthropic')),
    -- §7: the DM serves the other vendor, and an unlisted provider gets none.
    CONSTRAINT "AmuxDecisionMakerRequest_provider_instance_check"
      CHECK (
        ("askingProvider" = 'claude' AND "instance" IS NOT DISTINCT FROM 'decision-maker-openai')
        OR ("askingProvider" = 'codex' AND "instance" IS NOT DISTINCT FROM 'decision-maker-anthropic')
        OR ("askingProvider" NOT IN ('claude', 'codex') AND "instance" IS NULL)
      ),
    -- routeDmQuestion()'s refusal codes (lib/amux/decisionMakerCore.ts), as a
    -- one-dimensional list with no NULL. The guard refuses a repeated code.
    CONSTRAINT "AmuxDecisionMakerRequest_refusal_codes_check"
      CHECK (
        "refusalCodes" IS NOT NULL
        AND "refusalCodes" <@ ARRAY[
          'kill_switch_on', 'settings_unreadable', 'instance_off', 'ask_type_not_allowed',
          'irreversible_term', 'resolution_not_decision_only', 'provider_unverified',
          'throughput_exceeded', 'input_limit_exceeded', 'card_secret_detected'
        ]::TEXT[]
        AND array_position("refusalCodes", NULL) IS NULL
        AND coalesce(array_ndims("refusalCodes"), 1) = 1
      ),
    CONSTRAINT "AmuxDecisionMakerRequest_route_refusals_check"
      CHECK (("route" = 'dm_proposal') = (cardinality("refusalCodes") = 0)),
    CONSTRAINT "AmuxDecisionMakerRequest_unverified_provider_check"
      CHECK (('provider_unverified' = ANY ("refusalCodes")) = ("instance" IS NULL))
);

CREATE UNIQUE INDEX "AmuxDecisionMakerRequest_auditLogId_key"
  ON "AmuxDecisionMakerRequest"("auditLogId");
-- §9: "요청은 (카드 id, 질문 revision)당 하나다."
CREATE UNIQUE INDEX "AmuxDecisionMakerRequest_cardId_questionRevision_key"
  ON "AmuxDecisionMakerRequest"("cardId", "questionRevision");
-- §3-6's throughput read: requests routed to one instance in the last day.
CREATE INDEX "AmuxDecisionMakerRequest_instance_createdAt_idx"
  ON "AmuxDecisionMakerRequest"("instance", "createdAt");

ALTER TABLE "AmuxDecisionMakerRequest"
  ADD CONSTRAINT "AmuxDecisionMakerRequest_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxDecisionMakerRequestEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "instance" TEXT,
    "vendor" TEXT,
    "inputPayloadDigest" TEXT,
    "snapshotState" TEXT,
    "snapshotTargetSha" TEXT,
    "snapshotManifestDigest" TEXT,
    "resultKind" TEXT,
    "resultDigest" TEXT,
    "rejectionReason" TEXT,
    "resultDeadlineAt" TIMESTAMPTZ(3),
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerRequestEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_kind_check"
      CHECK ("kind" IN (
        'assign', 'assign_discarded', 'transmit_intent', 'transmit_receipt', 'transmit_unknown',
        'result', 'result_rejected', 'result_unknown', 'stale_close'
      )),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_check"
      CHECK ("instance" IS NULL OR "instance" IN ('decision-maker-openai', 'decision-maker-anthropic')),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_vendor_check"
      CHECK ("vendor" IS NULL OR "vendor" IN ('openai', 'anthropic')),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_snapshot_state_check"
      CHECK ("snapshotState" IS NULL OR "snapshotState" IN ('none', 'worker_head', 'develop')),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_result_kind_check"
      CHECK ("resultKind" IS NULL OR "resultKind" IN (
        'proposal', 'escalate', 'validation_failure', 'timeout', 'unavailable'
      )),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_rejection_reason_check"
      CHECK ("rejectionReason" IS NULL OR "rejectionReason" IN (
        'request_closed', 'terminal_exists', 'result_unknown', 'not_transmitted',
        'deadline_passed', 'binding_mismatch', 'kill_switch'
      )),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_digest_format_check"
      CHECK (
        ("inputPayloadDigest" IS NULL OR "inputPayloadDigest" ~ '^[0-9a-f]{64}$')
        AND ("snapshotManifestDigest" IS NULL OR "snapshotManifestDigest" ~ '^[0-9a-f]{64}$')
        AND ("resultDigest" IS NULL OR "resultDigest" ~ '^[0-9a-f]{64}$')
        AND ("snapshotTargetSha" IS NULL OR "snapshotTargetSha" ~ '^[0-9a-f]{40}$')
      ),
    -- What each kind carries, and nothing more. The router's kinds name no
    -- instance; every other kind names the request's own.
    CONSTRAINT "AmuxDecisionMakerRequestEvent_instance_kind_check"
      CHECK (("kind" IN ('assign', 'assign_discarded', 'stale_close')) = ("instance" IS NULL)),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_result_deadline_kind_check"
      CHECK (("kind" = 'assign') = ("resultDeadlineAt" IS NOT NULL)),
    -- §5, §10: the transmission intent records the vendor, the payload digest
    -- and the snapshot; a target SHA and a manifest exactly when the snapshot
    -- is not none.
    CONSTRAINT "AmuxDecisionMakerRequestEvent_transmit_intent_shape_check"
      CHECK (
        "kind" <> 'transmit_intent'
        OR (
          "vendor" IS NOT NULL
          AND "inputPayloadDigest" IS NOT NULL
          AND "snapshotState" IS NOT NULL
          AND ("snapshotState" = 'none') = ("snapshotTargetSha" IS NULL)
          AND ("snapshotState" = 'none') = ("snapshotManifestDigest" IS NULL)
        )
      ),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_intent_columns_check"
      CHECK (
        "kind" = 'transmit_intent'
        OR (
          "vendor" IS NULL AND "snapshotState" IS NULL
          AND "snapshotTargetSha" IS NULL AND "snapshotManifestDigest" IS NULL
        )
      ),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_vendor_instance_check"
      CHECK (
        "vendor" IS NULL
        OR ("vendor" = 'openai' AND "instance" IS NOT DISTINCT FROM 'decision-maker-openai')
        OR ("vendor" = 'anthropic' AND "instance" IS NOT DISTINCT FROM 'decision-maker-anthropic')
      ),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_payload_kind_check"
      CHECK (("kind" IN ('transmit_intent', 'result')) OR "inputPayloadDigest" IS NULL),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_result_columns_check"
      CHECK (("kind" = 'result') = ("resultKind" IS NOT NULL)),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_rejection_columns_check"
      CHECK (("kind" = 'result_rejected') = ("rejectionReason" IS NOT NULL)),
    CONSTRAINT "AmuxDecisionMakerRequestEvent_result_digest_kind_check"
      CHECK (("kind" IN ('result', 'result_rejected', 'result_unknown')) = ("resultDigest" IS NOT NULL))
);

CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_sequence_key"
  ON "AmuxDecisionMakerRequestEvent"("sequence");
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_auditLogId_key"
  ON "AmuxDecisionMakerRequestEvent"("auditLogId");
CREATE INDEX "AmuxDecisionMakerRequestEvent_requestId_sequence_idx"
  ON "AmuxDecisionMakerRequestEvent"("requestId", "sequence");
-- One of each per request. The result index is §6 and §9's "DB 유일 제약":
-- a request has one terminal result, whatever its digest.
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_assign_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'assign';
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_transmit_intent_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'transmit_intent';
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_transmit_outcome_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" IN ('transmit_receipt', 'transmit_unknown');
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_result_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'result';
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_result_unknown_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" = 'result_unknown';
CREATE UNIQUE INDEX "AmuxDecisionMakerRequestEvent_one_closing_key"
  ON "AmuxDecisionMakerRequestEvent"("requestId") WHERE "kind" IN ('assign_discarded', 'stale_close');

ALTER TABLE "AmuxDecisionMakerRequestEvent"
  ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AmuxDecisionMakerRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxDecisionMakerRequestEvent"
  ADD CONSTRAINT "AmuxDecisionMakerRequestEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
    NEW."assignmentDeadlineAt" := NEW."createdAt" + INTERVAL '2 minutes';
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_decision_maker_request_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerRequest"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_request_guard"();

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
            NOT closed AND now_at >= request_created_at + INTERVAL '30 days'
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

CREATE TRIGGER "amux_decision_maker_request_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerRequestEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_request_event_guard"();

-- At COMMIT, before the commit record is written: an assignment, a
-- transmission intent or a DM output whose transaction reaches COMMIT at or
-- after its deadline less the reserve fails with AX001 and PostgreSQL rolls
-- the whole transaction back. Reads only the request row and the assignment,
-- neither of which can change.
CREATE OR REPLACE FUNCTION "amux_decision_maker_request_event_commit_check"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    deadline TIMESTAMPTZ;
BEGIN
    IF NEW."kind" = 'assign' THEN
        EXECUTE pg_catalog.format(
            'SELECT "assignmentDeadlineAt" FROM %I.%I WHERE "id" = $1',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequest'
        ) INTO deadline USING NEW."requestId";
    ELSE
        EXECUTE pg_catalog.format(
            'SELECT "resultDeadlineAt" FROM %I.%I WHERE "requestId" = $1 AND "kind" = ''assign''',
            TG_TABLE_SCHEMA,
            'AmuxDecisionMakerRequestEvent'
        ) INTO deadline USING NEW."requestId";
    END IF;
    IF deadline IS NULL OR pg_catalog.clock_timestamp() >= deadline - INTERVAL '200 milliseconds' THEN
        RAISE EXCEPTION 'AMUX_DM_LATE_COMMIT' USING ERRCODE = 'AX001';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "amux_decision_maker_request_event_commit_check"
    AFTER INSERT ON "AmuxDecisionMakerRequestEvent"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (
        NEW."kind" IN ('assign', 'transmit_intent')
        OR (NEW."kind" = 'result' AND NEW."resultKind" IN ('proposal', 'escalate', 'validation_failure'))
    )
    EXECUTE FUNCTION "amux_decision_maker_request_event_commit_check"();

COMMIT;
