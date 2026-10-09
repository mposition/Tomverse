-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- section 10 (with sections 6 and 9 where they meet it): the body store, its
-- retention events, the digest-key registry and the structured detail of a
-- terminal result, stage S1d. Additive only: four new tables, five functions
-- and five triggers. One trigger is on the S1c request event table and writes
-- a retention row when a request closes; no existing row, column, constraint
-- or function changes.
--
-- AmuxDecisionMakerBody holds section 10's five body fields and nothing else:
-- the question card text (16 KiB), the DM's answer (8 KiB), its rationale
-- (4 KiB), its escalation reason (1 KiB, shown in Admin only) and the
-- operator's edited answer (8 KiB), at most one row per field per request, so
-- a request holds at most 37 KiB -- the trigger also refuses anything over
-- section 10's 40 KiB. Each row names its key period and is identified by a
-- keyed digest. AmuxDecisionMakerRetentionEvent is section 10's separate
-- append-only retention history: retention_set, hold_set and hold_release.
-- AmuxDecisionMakerDigestKeyEvent records each key period's rotation into use
-- and its destruction. AmuxDecisionMakerResultDetail is part of the decision
-- ledger, not the body store: one immutable row per terminal result, written
-- with it, that keeps what the ledger's digest cannot -- the DM output's kind,
-- the option a select chose and the irreversible flag Admin shows before the
-- operator judges (section 6) -- and the key check value the result was
-- digested under. It holds no free text: the option id has a closed grammar.
--
-- Digest keys, the decision this stage makes (section 10: "본문 식별은 서버
-- 키의 keyed digest로 하며 평문 hash를 두지 않는다"; lib/amux/decisionMakerBodyCore.ts):
--
-- * One random 32-byte key per 30-day key period: whole periods since the Unix
--   epoch, floor(epoch ms / 2,592,000,000). The keys live only in the server's
--   secret store (AMUX_DM_DIGEST_KEYS) -- never in this database, a log or an
--   audit entry. This database stores, per period, only a key check value,
--   HMAC-SHA256(K_P, "amux-dm-digest-key-check-v1").
-- * A request's period is that of its database-clock "createdAt", which is
--   immutable, so every digest of one request -- a retried result submission
--   included -- is keyed by the same key.
-- * The request key is K_R = HMAC-SHA256(K_P, "amux-dm-request-key-v1" NUL
--   requestId). The app hands K_R to the broker at assignment. Every digest of
--   the request is an HMAC-SHA256 under K_R with its own label: the option set
--   digest of the S1c binding ("optionSetDigest", computed by the request
--   store at routing from the card's options, and recomputed from the options
--   a result is submitted with, which must match), the broker's input payload
--   and snapshot manifest digests ("inputPayloadDigest",
--   "snapshotManifestDigest"), the result digest ("resultDigest", computed by
--   the app from the output bytes it stores), and each body row's "digest"
--   over its field and text.
-- * What someone with read access to this database but no key can learn: every
--   body while its row exists (the store is plaintext by design: section 10
--   needs it to judge a proposal), identifiers, timings, closed codes, field
--   names and counts, key periods and key check values. What they cannot: once
--   a body is deleted, test a guess of it against any digest (an HMAC under an
--   unknown 256-bit key is a pseudorandom function), tell that two bodies or
--   payloads of different requests are equal (each request has its own K_R),
--   or recover a key from a key check value. Once a period's key is destroyed
--   nobody can, the server included.
--
-- What the database enforces, rather than the application:
--
-- * Bodies. The field is one of the five; the text is 1 byte up to its field's
--   cap; one row per (request, field) and at most 40 KiB per request. A row is
--   written only for an open request routed to a DM, in its request's key
--   period, under that period's registered key check value and never after
--   the period's destruction, and with the audit row of its own transaction
--   that wrote what it belongs to: the card text with the router's
--   amux.decision.route naming the request (the request row itself, of this
--   transaction); the DM's answer and rationale with the request instance's
--   amux.decision.result for the request's result of kind proposal, and its
--   escalation reason with that of kind escalate (the result event, of this
--   transaction); the operator's answer with a person's
--   amux.decision.edit_confirm targeting the request and naming it in its
--   metadata (the judgment table is a later stage). "createdAt" is the
--   database clock.
--   UPDATE is refused. DELETE is allowed only with no hold open on the
--   request and either (1) the router's amux.decision.body_purge of this
--   transaction naming the request and listing the field, once the request's
--   retentionUntil has passed by the database clock, or (2) a person's
--   amux.decision.body_erase of this transaction naming the request and
--   listing the field -- section 10's one exception, a confirmed personal-data
--   deletion request.
-- * Retention events. retention_set is written when the request closes -- by
--   the trigger on the request event table below, for assign_discarded and
--   stale_close -- once per request (a partial unique index), with
--   retentionUntil = the closing event's database-clock "createdAt" + 2160
--   hours, named by the closing event's own router audit of the same
--   transaction. Hours, not '90 days': a day-based interval on timestamptz
--   follows the session time zone's calendar, so across a DST change it is an
--   hour short or long, while the application counts exactly 90 x 86,400,000
--   ms. The key period boundaries are epoch arithmetic, also fixed.
--   hold_set only when no hold is open, hold_release only when one is; an open
--   hold is more hold_set than hold_release, counting hold events only. Each
--   hold event is a person's, with that person's amux.decision.legal_hold of
--   the same transaction naming the event. "keyPeriod" is the request's.
--   UPDATE and DELETE are refused.
-- * Key events. rotate once per period, never after its destruction and no
--   further ahead than the next period, with its key check value. destroy
--   once, after a rotation, only once the period has ended and no body row of
--   the period remains, no hold is open on one of its requests and none of
--   its requests routed to a DM is still open. Each with the router's
--   amux.decision.digest_key_rotate or .digest_key_destroy of the same
--   transaction naming the event. UPDATE and DELETE are refused.
-- * Result details. One per request, for its result event of this transaction
--   (kind result, of the same request, the same result kind, named by the same
--   audit row), in its request's key period, under that period's registered
--   key check value and never after its destruction -- so no terminal result
--   commits with a detail whose key the registry does not hold. The shape is a
--   CHECK: a proposal is a select (with its option id) or a free text answer,
--   both with irreversible; an escalation has neither; a validation failure,
--   a timeout and an unavailable DM have no output. The option id follows the
--   S1a grammar (letters, digits, _ and -, 32 at most). UPDATE and DELETE are
--   refused: like the ledger it belongs to, it is never removed.
-- * Serialization. Every body write and retention event takes the request's
--   transaction advisory lock -- the one the S1c ledger's event guard takes --
--   so a hold, a close, a body insert and a delete of one request commit one
--   after the other (section 10: "사건 삽입과 본문 삭제는 요청 단위 advisory
--   lock으로 직렬화한다"). A body insert and a hold event then take their key
--   period's lock shared, and a key event takes it exclusive, so a destruction
--   never commits on a read that missed a body or a hold. A result detail
--   takes the request lock and the key period lock shared, as a body does.
--   Lock order: the audit chain lock (every store path takes it first), the
--   request lock, the key period lock. All four guards read after a lock and
--   refuse any isolation
--   level but READ COMMITTED (20261008090000_amux_decision_maker_switch_serialization
--   explains why).
-- * Every row's "id" is a lowercase UUID and every digest and key check value
--   64 lowercase hex characters.
-- * No CHECK here passes on NULL. A CHECK accepts a row when its expression is
--   NULL, so each single-column CHECK on a nullable column says "IS NULL OR",
--   and each CHECK over several columns is held to IS TRUE, comparing a
--   nullable column only with IS [NOT] DISTINCT FROM or IS [NOT] NULL.
--
-- Under the kill switch every write here stays allowed (section 6's table:
-- legal hold, body deletion, stale close and expiry deletion), so no guard
-- reads the switches. A body of a proposal is written only with the
-- proposal's result event, which the S1c guard refuses under the kill switch.
--
-- TRUNCATE is not refused, as with the switch store and the ledger
-- (20261008030000_amux_decision_maker_switch): the DB integration suites reset
-- AdminAuditLog with TRUNCATE ... CASCADE, which reaches these tables through
-- their foreign keys.
--
-- Every function pins search_path to pg_catalog, pg_temp and reads and writes
-- the tables through TG_TABLE_SCHEMA, so no object earlier on a session's path
-- can stand in for them.
--
-- `prisma db push` creates the tables and none of the functions, triggers,
-- CHECKs or partial indexes. The DB integration suite runs on the migration
-- history (scripts/run-db-integration-tests.mjs), which is where all of them
-- are tested (tests/integration/amux-decision-maker-body.db.test.ts).
--
-- Rollback: drop the trigger on the request event table and its function,
-- then the four tables' triggers and functions, then the four tables (their
-- foreign keys go with them; AdminAuditLog and the ledger are not changed).
-- That discards every stored body, every result detail and the key registry;
-- the server's keys are untouched. Nothing reads these tables yet: no route,
-- Admin screen or DM process exists in this stage.

BEGIN;

CREATE TABLE "AmuxDecisionMakerDigestKeyEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "keyPeriod" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "keyCheck" TEXT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_kind_check"
      CHECK ("kind" IN ('rotate', 'destroy')),
    CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_key_period_check"
      CHECK ("keyPeriod" >= 0),
    -- A rotation records the key check value, a destruction nothing.
    CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_key_check_shape_check"
      CHECK ((
        ("kind" = 'rotate') = ("keyCheck" IS NOT NULL)
        AND ("keyCheck" IS NULL OR "keyCheck" ~ '^[0-9a-f]{64}$')
      ) IS TRUE)
);

CREATE UNIQUE INDEX "AmuxDecisionMakerDigestKeyEvent_sequence_key"
  ON "AmuxDecisionMakerDigestKeyEvent"("sequence");
CREATE UNIQUE INDEX "AmuxDecisionMakerDigestKeyEvent_auditLogId_key"
  ON "AmuxDecisionMakerDigestKeyEvent"("auditLogId");
CREATE UNIQUE INDEX "AmuxDecisionMakerDigestKeyEvent_one_rotate_key"
  ON "AmuxDecisionMakerDigestKeyEvent"("keyPeriod") WHERE "kind" = 'rotate';
CREATE UNIQUE INDEX "AmuxDecisionMakerDigestKeyEvent_one_destroy_key"
  ON "AmuxDecisionMakerDigestKeyEvent"("keyPeriod") WHERE "kind" = 'destroy';

ALTER TABLE "AmuxDecisionMakerDigestKeyEvent"
  ADD CONSTRAINT "AmuxDecisionMakerDigestKeyEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxDecisionMakerBody" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "keyPeriod" INTEGER NOT NULL,
    "keyCheck" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerBody_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerBody_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerBody_field_check"
      CHECK ("field" IN ('card_text', 'dm_answer', 'dm_rationale', 'dm_escalation_reason', 'operator_answer')),
    -- Section 10's caps in UTF-8 bytes (the database encoding is UTF8).
    CONSTRAINT "AmuxDecisionMakerBody_text_size_check"
      CHECK ((
        octet_length("text") >= 1
        AND octet_length("text") <= CASE "field"
          WHEN 'card_text' THEN 16384
          WHEN 'dm_answer' THEN 8192
          WHEN 'dm_rationale' THEN 4096
          WHEN 'dm_escalation_reason' THEN 1024
          WHEN 'operator_answer' THEN 8192
          ELSE 0
        END
      ) IS TRUE),
    CONSTRAINT "AmuxDecisionMakerBody_key_period_check"
      CHECK ("keyPeriod" >= 0),
    CONSTRAINT "AmuxDecisionMakerBody_digest_format_check"
      CHECK (("digest" ~ '^[0-9a-f]{64}$' AND "keyCheck" ~ '^[0-9a-f]{64}$') IS TRUE)
);

-- One row per field per request: section 10's five fields, 37 KiB at most.
CREATE UNIQUE INDEX "AmuxDecisionMakerBody_requestId_field_key"
  ON "AmuxDecisionMakerBody"("requestId", "field");
CREATE INDEX "AmuxDecisionMakerBody_keyPeriod_idx"
  ON "AmuxDecisionMakerBody"("keyPeriod");
CREATE INDEX "AmuxDecisionMakerBody_auditLogId_idx"
  ON "AmuxDecisionMakerBody"("auditLogId");

ALTER TABLE "AmuxDecisionMakerBody"
  ADD CONSTRAINT "AmuxDecisionMakerBody_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AmuxDecisionMakerRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxDecisionMakerBody"
  ADD CONSTRAINT "AmuxDecisionMakerBody_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "AmuxDecisionMakerRetentionEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "requestId" TEXT NOT NULL,
    "keyPeriod" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "retentionUntil" TIMESTAMPTZ(3),
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerRetentionEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerRetentionEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerRetentionEvent_kind_check"
      CHECK ("kind" IN ('retention_set', 'hold_set', 'hold_release')),
    CONSTRAINT "AmuxDecisionMakerRetentionEvent_actor_kind_check"
      CHECK ("actorKind" IN ('human', 'system')),
    CONSTRAINT "AmuxDecisionMakerRetentionEvent_key_period_check"
      CHECK ("keyPeriod" >= 0),
    -- The retention is the system's, at the close; a hold is a person's.
    CONSTRAINT "AmuxDecisionMakerRetentionEvent_actor_shape_check"
      CHECK ((
        ("kind" = 'retention_set') = ("actorKind" = 'system')
        AND ("actorKind" = 'human') = ("actorUserId" IS NOT NULL)
        AND ("kind" = 'retention_set') = ("retentionUntil" IS NOT NULL)
      ) IS TRUE)
);

CREATE UNIQUE INDEX "AmuxDecisionMakerRetentionEvent_sequence_key"
  ON "AmuxDecisionMakerRetentionEvent"("sequence");
CREATE UNIQUE INDEX "AmuxDecisionMakerRetentionEvent_auditLogId_key"
  ON "AmuxDecisionMakerRetentionEvent"("auditLogId");
CREATE INDEX "AmuxDecisionMakerRetentionEvent_requestId_sequence_idx"
  ON "AmuxDecisionMakerRetentionEvent"("requestId", "sequence");
CREATE INDEX "AmuxDecisionMakerRetentionEvent_keyPeriod_kind_idx"
  ON "AmuxDecisionMakerRetentionEvent"("keyPeriod", "kind");
-- Section 10: "retention_set ... 요청당 하나다(부분 유일 제약)".
CREATE UNIQUE INDEX "AmuxDecisionMakerRetentionEvent_one_retention_key"
  ON "AmuxDecisionMakerRetentionEvent"("requestId") WHERE "kind" = 'retention_set';

ALTER TABLE "AmuxDecisionMakerRetentionEvent"
  ADD CONSTRAINT "AmuxDecisionMakerRetentionEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AmuxDecisionMakerRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxDecisionMakerRetentionEvent"
  ADD CONSTRAINT "AmuxDecisionMakerRetentionEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
        -- period's requests routed to a DM may be open.
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM %1$I.%2$I r WHERE r."route" = ''dm_proposal'''
            || ' AND r."createdAt" >= pg_catalog.to_timestamp($1::double precision * 2592000)'
            || ' AND r."createdAt" < pg_catalog.to_timestamp(($1 + 1)::double precision * 2592000)'
            || ' AND NOT EXISTS (SELECT 1 FROM %1$I.%3$I e WHERE e."requestId" = r."id" AND e."kind" IN (''assign_discarded'', ''stale_close''))',
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

CREATE TRIGGER "amux_decision_maker_digest_key_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerDigestKeyEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_digest_key_event_guard"();

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
    -- its creation, and a closed one gains no body.
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "requestId" = $1 AND "kind" IN (''assign_discarded'', ''stale_close''))',
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

CREATE TRIGGER "amux_decision_maker_body_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerBody"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_body_guard"();

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
        -- router audit of this transaction: the retention starts at the close.
        EXECUTE pg_catalog.format(
            'SELECT e."createdAt" FROM %1$I.%2$I e JOIN %1$I.%3$I a ON a."id" = e."auditLogId" WHERE e."auditLogId" = $1 AND e."requestId" = $2 AND e."kind" IN (''assign_discarded'', ''stale_close'') AND e.xmin = pg_catalog.pg_current_xact_id()::xid AND a."action" = ''amux.decision.'' || e."kind" AND a."targetType" = ''AmuxDecisionMakerRequestEvent'' AND a."targetId" = e."id" AND a."actorUserId" IS NULL AND a."actorEmail" IS NULL AND a."ipAddress" IS NULL AND a."userAgent" IS NULL AND pg_catalog.jsonb_typeof(a."metadata") = ''object'' AND a."metadata" ->> ''systemActor'' = ''amux-decision-router'' AND a.xmin = pg_catalog.pg_current_xact_id()::xid',
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

CREATE TRIGGER "amux_decision_maker_retention_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerRetentionEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_retention_event_guard"();

CREATE TABLE "AmuxDecisionMakerResultDetail" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "resultEventId" TEXT NOT NULL,
    "resultKind" TEXT NOT NULL,
    "outputKind" TEXT,
    "optionId" TEXT,
    "irreversible" BOOLEAN,
    "keyPeriod" INTEGER NOT NULL,
    "keyCheck" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerResultDetail_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerResultDetail_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerResultDetail_result_kind_check"
      CHECK ("resultKind" IN ('proposal', 'escalate', 'validation_failure', 'timeout', 'unavailable')),
    CONSTRAINT "AmuxDecisionMakerResultDetail_output_kind_check"
      CHECK ("outputKind" IS NULL OR "outputKind" IN ('select', 'free_text', 'escalate')),
    -- The S1a grammar (lib/amux/decisionMakerCore.ts DM_OPTION_ID_PATTERN): a
    -- token, never prose.
    CONSTRAINT "AmuxDecisionMakerResultDetail_option_id_format_check"
      CHECK ("optionId" IS NULL OR "optionId" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    -- Section 6: what each terminal result carries. A CHECK passes when its
    -- expression is NULL, and three of these columns are nullable, so every
    -- comparison with a nullable column is IS [NOT] DISTINCT FROM or IS [NOT]
    -- NULL, and the whole is held to IS TRUE: a NULL output kind or flag can
    -- never satisfy a branch by making it unknown.
    CONSTRAINT "AmuxDecisionMakerResultDetail_shape_check"
      CHECK ((
        (
          "resultKind" = 'proposal'
          AND "irreversible" IS NOT NULL
          AND (
            ("outputKind" IS NOT DISTINCT FROM 'select' AND "optionId" IS NOT NULL)
            OR ("outputKind" IS NOT DISTINCT FROM 'free_text' AND "optionId" IS NULL)
          )
        )
        OR (
          "resultKind" = 'escalate'
          AND "outputKind" IS NOT DISTINCT FROM 'escalate' AND "optionId" IS NULL AND "irreversible" IS NULL
        )
        OR (
          "resultKind" IN ('validation_failure', 'timeout', 'unavailable')
          AND "outputKind" IS NULL AND "optionId" IS NULL AND "irreversible" IS NULL
        )
      ) IS TRUE),
    CONSTRAINT "AmuxDecisionMakerResultDetail_key_check"
      CHECK (("keyPeriod" >= 0 AND "keyCheck" ~ '^[0-9a-f]{64}$') IS TRUE)
);

CREATE UNIQUE INDEX "AmuxDecisionMakerResultDetail_requestId_key"
  ON "AmuxDecisionMakerResultDetail"("requestId");
CREATE UNIQUE INDEX "AmuxDecisionMakerResultDetail_resultEventId_key"
  ON "AmuxDecisionMakerResultDetail"("resultEventId");
CREATE UNIQUE INDEX "AmuxDecisionMakerResultDetail_auditLogId_key"
  ON "AmuxDecisionMakerResultDetail"("auditLogId");

ALTER TABLE "AmuxDecisionMakerResultDetail"
  ADD CONSTRAINT "AmuxDecisionMakerResultDetail_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "AmuxDecisionMakerRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxDecisionMakerResultDetail"
  ADD CONSTRAINT "AmuxDecisionMakerResultDetail_resultEventId_fkey"
  FOREIGN KEY ("resultEventId") REFERENCES "AmuxDecisionMakerRequestEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxDecisionMakerResultDetail"
  ADD CONSTRAINT "AmuxDecisionMakerResultDetail_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "amux_decision_maker_result_detail_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    request_created_at TIMESTAMPTZ;
    linked BOOLEAN;
    registered_check TEXT;
    destroyed BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_IMMUTABLE';
    END IF;
    -- The request's result and the period's registry are read after locks.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_ISOLATION';
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
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_NO_REQUEST';
    END IF;
    IF NEW."keyPeriod" <> pg_catalog.floor(EXTRACT(EPOCH FROM request_created_at) * 1000 / 2592000000)::INTEGER THEN
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_KEY_PERIOD';
    END IF;
    -- The request's terminal result, recorded by this very transaction, of the
    -- same kind and named by the same audit row.
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "requestId" = $2 AND "kind" = ''result'' AND "resultKind" = $3 AND "auditLogId" = $4 AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRequestEvent'
    ) INTO linked USING NEW."resultEventId", NEW."requestId", NEW."resultKind", NEW."auditLogId";
    IF linked IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_UNLINKED';
    END IF;
    -- The key the result was digested under: registered for the period and not
    -- destroyed. Shared, as a body takes it, against a destruction's exclusive.
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtext('tomverse-amux-decision-maker-key-period:' || NEW."keyPeriod"::text)
    );
    EXECUTE pg_catalog.format(
        'SELECT max("keyCheck") FILTER (WHERE "kind" = ''rotate''), coalesce(bool_or("kind" = ''destroy''), false) FROM %I.%I WHERE "keyPeriod" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerDigestKeyEvent'
    ) INTO registered_check, destroyed USING NEW."keyPeriod";
    IF registered_check IS DISTINCT FROM NEW."keyCheck" OR destroyed THEN
        RAISE EXCEPTION 'AMUX_DM_RESULT_DETAIL_KEY';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER "amux_decision_maker_result_detail_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerResultDetail"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_result_detail_guard"();

-- Section 10: "retention_set은 요청이 닫힐 때 DB 시계로 계산한
-- retentionUntil(닫힘 + 90일)을 담으며 요청당 하나다" -- 2160 hours, a fixed
-- length (the header says why). When the S1c ledger
-- records a request's closing event, the same statement writes its
-- retention_set, named by the closing event's own audit row; the guard above
-- computes retentionUntil from the closing event's clock. A request routed to
-- the operator is closed from its creation, has no closing event and can hold
-- no body, so it has no retention. A later stage that adds a closing kind (the
-- operator's judgment, the delivery) adds it to this trigger's WHEN as well.
CREATE OR REPLACE FUNCTION "amux_decision_maker_request_closing_retention"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    EXECUTE pg_catalog.format(
        'INSERT INTO %1$I.%2$I ("id", "requestId", "keyPeriod", "kind", "retentionUntil", "actorKind", "actorUserId", "auditLogId")'
        || ' SELECT pg_catalog.gen_random_uuid()::text, r."id", pg_catalog.floor(EXTRACT(EPOCH FROM r."createdAt") * 1000 / 2592000000)::INTEGER,'
        || ' ''retention_set'', $2 + INTERVAL ''2160 hours'', ''system'', NULL, $3 FROM %1$I.%3$I r WHERE r."id" = $1',
        TG_TABLE_SCHEMA,
        'AmuxDecisionMakerRetentionEvent',
        'AmuxDecisionMakerRequest'
    ) USING NEW."requestId", NEW."createdAt", NEW."auditLogId";
    RETURN NULL;
END;
$$;

CREATE TRIGGER "amux_decision_maker_request_closing_retention"
    AFTER INSERT ON "AmuxDecisionMakerRequestEvent"
    FOR EACH ROW
    WHEN (NEW."kind" IN ('assign_discarded', 'stale_close'))
    EXECUTE FUNCTION "amux_decision_maker_request_closing_retention"();

COMMIT;
