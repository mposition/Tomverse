-- Support-triage decision records (docs/policy/support-triage.md §5, §6).
--
-- A person's decision on a suggestion, a group or a sample leaves one record
-- and one link per report it was bound to, in the same transaction. The record
-- holds the decision kind, when it was made, a keyed digest of what it was
-- bound to and the key version; the links hold the reports. No report text,
-- no lane, no flag and no person is stored. This migration writes no row.
--
-- What the database enforces:
--
--   * decidedAt is the database's clock and retentionUntil is exactly twelve
--     months later (a CHECK, so a different period needs a migration);
--   * records and links are inserted and deleted, never updated;
--   * a record commits with at least one link and at most fifty, and a link
--     is inserted only under READ COMMITTED, the one level where the cap holds
--     against every concurrent writer;
--   * no link to a deleted account's report;
--   * there is no record with some of its links gone: deleting any link, by
--     account deletion or by its report's deletion, deletes the record and
--     with it every other link.
--
-- The same READ COMMITTED requirement is added to support_triage_group_member_guard()
-- (migration 20261004020000_support_triage_group), which counts the same way;
-- it is replaced here, in a migration that also creates tables, so the deploy
-- guard never sees a migration that only replaces a function.
--
-- Time is the database's: clock_timestamp() AT TIME ZONE 'UTC'. Every function
-- pins search_path and has no EXCEPTION handler.

BEGIN;

CREATE TABLE "SupportTriageDecisionRecord" (
    "id" TEXT NOT NULL,
    "decisionKind" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decisionEnvelopeDigest" TEXT NOT NULL,
    "digestVersion" INTEGER NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTriageDecisionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportTriageDecisionRecord_retentionUntil_idx" ON "SupportTriageDecisionRecord"("retentionUntil");

CREATE INDEX "SupportTriageDecisionRecord_digestVersion_idx" ON "SupportTriageDecisionRecord"("digestVersion");

ALTER TABLE "SupportTriageDecisionRecord"
    ADD CONSTRAINT "SupportTriageDecisionRecord_decisionKind_check"
        CHECK ("decisionKind" IN ('suggestion_accepted', 'suggestion_rejected', 'group_confirmed', 'group_dismissed', 'sample_judged')),
    ADD CONSTRAINT "SupportTriageDecisionRecord_decisionEnvelopeDigest_check"
        CHECK ("decisionEnvelopeDigest" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "SupportTriageDecisionRecord_digestVersion_check"
        CHECK ("digestVersion" >= 1),
    -- limit: DECISION_RECORD_RETENTION_MONTHS
    ADD CONSTRAINT "SupportTriageDecisionRecord_retention_check"
        CHECK ("retentionUntil" = "decidedAt" + INTERVAL '12 months');

CREATE TABLE "SupportTriageDecisionRecordLink" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,

    CONSTRAINT "SupportTriageDecisionRecordLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTriageDecisionRecordLink_recordId_feedbackId_key" ON "SupportTriageDecisionRecordLink"("recordId", "feedbackId");

CREATE INDEX "SupportTriageDecisionRecordLink_feedbackId_idx" ON "SupportTriageDecisionRecordLink"("feedbackId");

ALTER TABLE "SupportTriageDecisionRecordLink" ADD CONSTRAINT "SupportTriageDecisionRecordLink_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "SupportTriageDecisionRecord"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "SupportTriageDecisionRecordLink" ADD CONSTRAINT "SupportTriageDecisionRecordLink_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "support_triage_decision_record_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- limit: DECISION_RECORD_RETENTION_MONTHS
    retention CONSTANT INTERVAL := interval '12 months';
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecord rows are inserted and deleted, never updated'
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
    NEW."retentionUntil" := NEW."decidedAt" + retention;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageDecisionRecord_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageDecisionRecord"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_decision_record_guard"();

-- At commit, a record that still exists has a link. Deferred, so the record
-- and its links can be inserted in either order inside one transaction.
CREATE OR REPLACE FUNCTION "support_triage_decision_record_has_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    still_exists BOOLEAN;
    has_link BOOLEAN;
BEGIN
    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I."SupportTriageDecisionRecord" r WHERE r."id" = $1),
                EXISTS (SELECT 1 FROM %I."SupportTriageDecisionRecordLink" l WHERE l."recordId" = $1)',
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO still_exists, has_link USING NEW."id";
    IF still_exists AND NOT has_link THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecord % has no link', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "SupportTriageDecisionRecord_has_link"
    AFTER INSERT ON "SupportTriageDecisionRecord"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "support_triage_decision_record_has_link"();

CREATE OR REPLACE FUNCTION "support_triage_decision_record_link_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- The message lib/accountDeletion.ts leaves on a deleted account's report.
    deleted_marker CONSTANT TEXT := '[deleted account]';
    -- limit: DECISION_RECORD_LINKS_MAX
    link_cap CONSTANT INTEGER := 50;
    report_message TEXT;
    links INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecordLink rows are inserted and deleted, never updated'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The report first, then the record: the global lock order.
    EXECUTE pg_catalog.format(
        'SELECT f."message" FROM %I."Feedback" f WHERE f."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO report_message USING NEW."feedbackId";
    IF report_message = deleted_marker THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecordLink cannot link a deleted account''s report'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The cap below is counted after the lock, and only READ COMMITTED counts
    -- with a fresh snapshot there. REPEATABLE READ and SERIALIZABLE count with
    -- the transaction's first snapshot and would miss an insert the lock
    -- already waited for; SSI does not cover a concurrent READ COMMITTED
    -- writer, so SERIALIZABLE is refused too. (PostgreSQL runs READ
    -- UNCOMMITTED as READ COMMITTED.)
    IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecordLink is inserted only under READ COMMITTED'
            USING ERRCODE = 'invalid_transaction_state';
    END IF;
    -- Lock, then count in a separate statement: one statement that waited for
    -- the lock would still count with the snapshot it took before waiting.
    EXECUTE pg_catalog.format(
        'SELECT 1 FROM %I."SupportTriageDecisionRecord" r WHERE r."id" = $1 FOR UPDATE',
        TG_TABLE_SCHEMA
    ) USING NEW."recordId";
    EXECUTE pg_catalog.format(
        'SELECT pg_catalog.count(*)::INTEGER FROM %I."SupportTriageDecisionRecordLink" l WHERE l."recordId" = $1',
        TG_TABLE_SCHEMA
    ) INTO links USING NEW."recordId";
    IF links >= link_cap THEN
        RAISE EXCEPTION 'SupportTriageDecisionRecord % already has % links', NEW."recordId", link_cap
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "SupportTriageDecisionRecordLink_guard"
    BEFORE INSERT OR UPDATE ON "SupportTriageDecisionRecordLink"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_decision_record_link_guard"();

-- No record outlives any of its links: a gone link takes the whole record,
-- and the record's cascade takes the other links. When the record itself is
-- being deleted the statement finds nothing.
CREATE OR REPLACE FUNCTION "support_triage_decision_record_link_gone"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    EXECUTE pg_catalog.format(
        'DELETE FROM %I."SupportTriageDecisionRecord" r WHERE r."id" = $1',
        TG_TABLE_SCHEMA
    ) USING OLD."recordId";
    RETURN NULL;
END;
$$;

CREATE TRIGGER "SupportTriageDecisionRecordLink_gone"
    AFTER DELETE ON "SupportTriageDecisionRecordLink"
    FOR EACH ROW EXECUTE FUNCTION "support_triage_decision_record_link_gone"();

-- Members: the fifty-member cap requires READ COMMITTED too.
CREATE OR REPLACE FUNCTION "support_triage_group_member_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    -- The message lib/accountDeletion.ts leaves on a deleted account's report.
    deleted_marker CONSTANT TEXT := '[deleted account]';
    -- limit: GROUP_MEMBER_CAP
    member_cap CONSTANT INTEGER := 50;
    report_message TEXT;
    members INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SupportTriageGroupMember rows are inserted and deleted, never updated'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The report first, then the group: the global lock order. No membership
    -- for a deleted account's report; the row is held so a deletion waits.
    EXECUTE pg_catalog.format(
        'SELECT f."message" FROM %I."Feedback" f WHERE f."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO report_message USING NEW."feedbackId";
    IF report_message = deleted_marker THEN
        RAISE EXCEPTION 'SupportTriageGroupMember cannot be created for a deleted account''s report'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The cap below is counted after the lock, and only READ COMMITTED counts
    -- with a fresh snapshot there. REPEATABLE READ and SERIALIZABLE count with
    -- the transaction's first snapshot and would miss an insert the lock
    -- already waited for; SSI does not cover a concurrent READ COMMITTED
    -- writer, so SERIALIZABLE is refused too. (PostgreSQL runs READ
    -- UNCOMMITTED as READ COMMITTED.)
    IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
        RAISE EXCEPTION 'SupportTriageGroupMember is inserted only under READ COMMITTED'
            USING ERRCODE = 'invalid_transaction_state';
    END IF;
    -- The group is locked by one statement and its members counted by the
    -- next, so two inserts cannot both see room for the fiftieth. One
    -- statement would not do: under READ COMMITTED a statement that waited
    -- for the lock still counts with the snapshot it took before waiting.
    EXECUTE pg_catalog.format(
        'SELECT 1 FROM %I."SupportTriageGroup" g WHERE g."id" = $1 FOR UPDATE',
        TG_TABLE_SCHEMA
    ) USING NEW."groupId";
    EXECUTE pg_catalog.format(
        'SELECT pg_catalog.count(*)::INTEGER FROM %I."SupportTriageGroupMember" m WHERE m."groupId" = $1',
        TG_TABLE_SCHEMA
    ) INTO members USING NEW."groupId";
    IF members >= member_cap THEN
        RAISE EXCEPTION 'SupportTriageGroup % already has % members', NEW."groupId", member_cap
            USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
    RETURN NEW;
END;
$$;

COMMIT;
