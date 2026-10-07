-- AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
-- sections 8 and 10: the switch store, stage S1b. Additive only: one new
-- table, one function and one trigger. No existing row, column or constraint
-- changes, and nothing here writes a row.
--
-- AmuxDecisionMakerSwitchEvent is an append-only list of switch events. The
-- state of a scope is its newest event, the one with the highest "sequence".
-- A scope with no event reads as its default: the kill switch off and each
-- instance 'off', which routes nothing to a DM (section 8: "기본 off").
--
-- What the database enforces, rather than the application:
--
-- * The scope is the kill switch or one of the two DM instances. The kill
--   switch holds only 'on' or 'off'; an instance holds only 'off' or
--   'proposal' (section 8: "저장소의 CHECK 제약이 다른 값을 거부한다"). No
--   other value -- 'autonomous' in particular -- can be stored.
-- * A person's event has reason 'operator' and names the person. A system
--   event is a latch: reason validation_latch or cleanup_latch, an instance
--   scope, value 'off', and no person (section 8, and section 5's
--   cleanup_unknown). The system can only turn an instance off.
-- * Every event names an AdminAuditLog row (foreign key, ON DELETE RESTRICT,
--   unique) that this very transaction wrote, targeting this event:
--     - a person's: by that same person, with no system marker, action
--       amux.decision.mode -- or amux.decision.latch_release when the scope's
--       newest event is a system latch, so the first change after a latch is
--       always recorded as its release;
--     - a latch: action amux.decision.latch, no person, IP or user agent, and
--       the system marker of the instance's own actor
--       (amux-decision-maker-openai or amux-decision-maker-anthropic).
-- * "sequence" is above every earlier event of the same scope, compared under
--   a transaction advisory lock on the scope, so the newest event is the one
--   committed last whatever order the sequence handed out numbers in.
-- * "createdAt" is the database clock of the insert.
-- * UPDATE and DELETE are refused. TRUNCATE is not, as with the AMUX halt
--   tables: it fires no row trigger, the application has no TRUNCATE anywhere
--   (scripts/check-protected-table-writers-core.mjs refuses one), and a
--   TRUNCATE in production is a schema-owner action outside the application.
--   The DB integration suites reset AdminAuditLog with TRUNCATE ... CASCADE,
--   which empties this table through the foreign key; a BEFORE TRUNCATE
--   trigger here would break them.
--
-- The function pins search_path to pg_catalog, pg_temp and reads both tables
-- through TG_TABLE_SCHEMA, so no object earlier on a session's path can stand
-- in for them.
--
-- `prisma db push` creates the table and none of the function, trigger or
-- CHECKs. The DB integration suite runs on the migration history
-- (scripts/run-db-integration-tests.mjs), which is where the trigger is
-- tested (tests/integration/amux-decision-maker-switch.db.test.ts).
--
-- Rollback: drop the trigger, the function, then the table (its foreign key
-- goes with it; AdminAuditLog is not changed). That discards the
-- switch history. lib/amux/decisionMakerSwitchStore.ts then fails to read,
-- which it reports as unreadable, and routeDmQuestion() sends every question
-- to the operator as settings_unreadable -- the same outcome as both
-- instances 'off'.

BEGIN;

CREATE TABLE "AmuxDecisionMakerSwitchEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "auditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxDecisionMakerSwitchEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_id_format_check"
      CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_scope_check"
      CHECK ("scope" IN ('kill_switch', 'decision-maker-openai', 'decision-maker-anthropic')),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_value_check"
      CHECK ("value" IN ('on', 'off', 'proposal')),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_scope_value_check"
      CHECK (
        ("scope" = 'kill_switch' AND "value" IN ('on', 'off'))
        OR ("scope" <> 'kill_switch' AND "value" IN ('off', 'proposal'))
      ),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_reason_code_check"
      CHECK ("reasonCode" IN ('operator', 'validation_latch', 'cleanup_latch')),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_actor_kind_check"
      CHECK ("actorKind" IN ('human', 'system')),
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_actor_user_check"
      CHECK (("actorKind" = 'human') = ("actorUserId" IS NOT NULL)),
    -- A person changes a switch only as an operator; the system only latches
    -- an instance off.
    CONSTRAINT "AmuxDecisionMakerSwitchEvent_actor_reason_check"
      CHECK (
        ("actorKind" = 'human' AND "reasonCode" = 'operator')
        OR (
          "actorKind" = 'system'
          AND "reasonCode" IN ('validation_latch', 'cleanup_latch')
          AND "scope" <> 'kill_switch'
          AND "value" = 'off'
        )
      )
);

CREATE UNIQUE INDEX "AmuxDecisionMakerSwitchEvent_sequence_key"
  ON "AmuxDecisionMakerSwitchEvent"("sequence");
CREATE UNIQUE INDEX "AmuxDecisionMakerSwitchEvent_auditLogId_key"
  ON "AmuxDecisionMakerSwitchEvent"("auditLogId");
CREATE INDEX "AmuxDecisionMakerSwitchEvent_scope_sequence_idx"
  ON "AmuxDecisionMakerSwitchEvent"("scope", "sequence");

ALTER TABLE "AmuxDecisionMakerSwitchEvent"
  ADD CONSTRAINT "AmuxDecisionMakerSwitchEvent_auditLogId_fkey"
  FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

CREATE TRIGGER "amux_decision_maker_switch_event_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerSwitchEvent"
    FOR EACH ROW EXECUTE FUNCTION "amux_decision_maker_switch_event_guard"();

COMMIT;
